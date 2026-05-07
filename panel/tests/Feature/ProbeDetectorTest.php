<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\FakeWebsite;
use App\Models\ServerConfig;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\RateLimiter;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// FakeSiteController's active-probing detector counts cover-site
// fall-through hits per source IP per minute and emits a single
// `probe.detected` warn line when the rate crosses the threshold.
// The detector was the load-bearing iteration-1 swap from raw
// `Cache::add`+`Cache::increment` to Laravel's RateLimiter facade,
// fixing a silent-miss bug where concurrent increments could take
// the bucket from N-1 → N+1 without any thread observing exactly
// N (the strict `===` threshold check missed the alarm).
//
// We anchor the post-cleanup contract via the OBSERVABLE side-
// effects on the RateLimiter (the count bucket and the `:alarmed`
// sentinel), not via mocking Log — the Log facade has too many
// ambient calls from middleware to make `shouldNotReceive` /
// `shouldReceive(...)->never()` reliable, and the cache state IS
// the contract anyway (the log line is just an external surface
// derived from the same state).

class ProbeDetectorTest extends TestCase
{
    use RefreshDatabase;

    private const THRESHOLD = 30;

    protected function setUp(): void
    {
        parent::setUp();
        ServerConfig::factory()->create();
        FakeWebsite::factory()->active()->create();
        // Each test gets clean rate-limiter state so a sentinel
        // from a prior test doesn't leak in.
        foreach (['127.0.0.1', '10.0.0.1', '10.0.0.2'] as $ip) {
            RateLimiter::clear('probe:'.$ip);
            RateLimiter::clear('probe:alarmed:'.$ip);
        }
    }

    /**
     * Hit a fresh cover-site URL N times from the supplied source
     * IP. Each URL is unique to keep the test signal clear (the
     * detector runs before any caching layer, but uniqueness
     * means an unrelated 304 path can't ever shadow the count).
     */
    private function hitCoverSiteNTimes(int $n, string $ip = '127.0.0.1'): void
    {
        for ($i = 0; $i < $n; $i++) {
            $this->withServerVariables(['REMOTE_ADDR' => $ip])
                ->get('/probe-test-'.$ip.'-'.$i)
                ->assertOk();
        }
    }

    private function alarmedFor(string $ip): bool
    {
        // The detector marks an IP as alarmed via
        // `RateLimiter::hit('probe:alarmed:'.$ip, 60)`. After
        // that hit, attempts() returns ≥1 for the sentinel key.
        return RateLimiter::attempts('probe:alarmed:'.$ip) >= 1;
    }

    #[Test]
    public function below_threshold_does_not_alarm(): void
    {
        $this->hitCoverSiteNTimes(self::THRESHOLD - 1);

        $this->assertFalse($this->alarmedFor('127.0.0.1'),
            'sentinel must NOT be set below threshold');
        $this->assertSame(self::THRESHOLD - 1, RateLimiter::attempts('probe:127.0.0.1'),
            'count bucket should match the number of fall-through hits');
    }

    #[Test]
    public function reaching_threshold_sets_alarm(): void
    {
        $this->hitCoverSiteNTimes(self::THRESHOLD);

        $this->assertTrue($this->alarmedFor('127.0.0.1'),
            'sentinel must be set at or above threshold');
        $this->assertSame(self::THRESHOLD, RateLimiter::attempts('probe:127.0.0.1'));
    }

    #[Test]
    public function continued_hits_within_window_do_not_re_alarm(): void
    {
        // The sentinel marks "alarm fired this window." Repeated
        // hits past the threshold must not re-fire — pre-iteration-1
        // the raw Cache pattern logged on every hit past threshold,
        // drowning legitimate signals.
        $this->hitCoverSiteNTimes(self::THRESHOLD + 20);

        $this->assertSame(1, RateLimiter::attempts('probe:alarmed:127.0.0.1'),
            'sentinel itself must be hit exactly once per (ip, decay-window)');
    }

    #[Test]
    public function distinct_source_ips_are_independent_buckets(): void
    {
        // 25 hits from .1, 25 hits from .2 — neither alone
        // crosses 30, so neither alarms. Pre-fix bug: collapsing
        // unidentified clients into a shared "unknown" bucket
        // could have spuriously alarmed when N distinct sources
        // each contributed under-threshold counts.
        $this->hitCoverSiteNTimes(25, '10.0.0.1');
        $this->hitCoverSiteNTimes(25, '10.0.0.2');

        $this->assertFalse($this->alarmedFor('10.0.0.1'));
        $this->assertFalse($this->alarmedFor('10.0.0.2'));
    }

    #[Test]
    public function each_distinct_ip_alarms_independently(): void
    {
        // After a clean threshold crossing on .1, a separate
        // crossing on .2 must alarm too — the sentinel is per-IP,
        // not global.
        $this->hitCoverSiteNTimes(self::THRESHOLD, '10.0.0.1');
        $this->hitCoverSiteNTimes(self::THRESHOLD, '10.0.0.2');

        $this->assertTrue($this->alarmedFor('10.0.0.1'));
        $this->assertTrue($this->alarmedFor('10.0.0.2'));
    }
}
