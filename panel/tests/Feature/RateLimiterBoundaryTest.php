<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\FakeWebsite;
use App\Models\ServerConfig;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\RateLimiter;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// Round-26 rate-limiter cohesion. Pins the off-by-one boundary
// of TWO intentionally-different RateLimiter idioms so a future
// "consistency" refactor can't silently shift either one:
//
//   - SubscriptionController uses CHECK-THEN-HIT — with max=60,
//     requests 1..60 succeed and the 61st is blocked. Standard
//     "60 / minute cap" semantics.
//   - FakeSiteController::maybeAlarmOnRapidFallThrough uses
//     HIT-THEN-CHECK — with PROBE_ALARM_RATE_PER_MIN=30, the
//     30th cover-site fall-through triggers the alarm (the
//     hit counts itself before the threshold check).
//
// Either ordering is correct for its use case; mixing them up
// would silently break behaviour that's hard to notice in
// production. These tests anchor the boundary on both sides.
class RateLimiterBoundaryTest extends TestCase
{
    use RefreshDatabase;

    /** @var array<int, array{level:string, message:string, context:array}> */
    private array $logged = [];

    protected function setUp(): void
    {
        parent::setUp();
        $this->logged = [];
        Event::listen(MessageLogged::class, function (MessageLogged $e): void {
            $this->logged[] = ['level' => $e->level, 'message' => $e->message, 'context' => $e->context];
        });
        RateLimiter::clear('subscription:127.0.0.1');
        RateLimiter::clear('probe:127.0.0.1');
        RateLimiter::clear('probe:alarmed:127.0.0.1');
    }

    private function seedActiveCover(): void
    {
        ServerConfig::factory()->create();
        FakeWebsite::factory()->active()->create();
    }

    /** @return array<int, array{level:string, message:string, context:array}> */
    private function loggedMatching(string $needle): array
    {
        return array_values(array_filter($this->logged, fn ($r) => str_contains($r['message'], $needle)));
    }

    #[Test]
    public function subscription_rate_limiter_passes_60th_blocks_61st(): void
    {
        // Pin: CHECK-THEN-HIT semantics. Burn 60 requests. Each
        // returns cover-site bytes (no fall-through reason matters
        // — we just need 60 hits on the same key). The 61st is
        // ALSO cover-site (round-12 keeps fall-through silent on
        // unknown tokens) but the LIMITER counter must show the
        // pre-block-trigger state was 60 attempts.
        $this->seedActiveCover();

        // Drive 60 hits — these all enter the controller, increment
        // the counter, and return cover-site (unknown token). The
        // 60th request is the LAST one that gets past
        // tooManyAttempts.
        for ($i = 0; $i < 60; $i++) {
            $this->get('/api/v1/subscription/burn-'.$i);
        }
        $this->assertSame(60, RateLimiter::attempts('subscription:127.0.0.1'));

        // The 61st request is blocked. tooManyAttempts returns true
        // (>= 60), so the controller takes the rate-limit branch
        // and falls through to the cover site WITHOUT calling hit()
        // again. The counter stays at 60.
        $this->get('/api/v1/subscription/the-61st');
        $this->assertSame(
            60,
            RateLimiter::attempts('subscription:127.0.0.1'),
            'CHECK-THEN-HIT: blocked requests must NOT increment the counter; '
            .'a flip to HIT-THEN-CHECK would tick this to 61 silently',
        );
    }

    #[Test]
    public function probe_alarm_fires_at_30th_hit_not_31st(): void
    {
        // Pin: HIT-THEN-CHECK semantics. The 30th cover-site fall-
        // through from a single IP triggers the probe.detected log.
        // (Anything BELOW 30 must NOT log.)
        $this->seedActiveCover();

        // Drive 29 cover-site fall-throughs. None should alarm.
        for ($i = 0; $i < 29; $i++) {
            $this->get('/some-unknown-path-'.$i);
        }
        $this->assertEmpty(
            $this->loggedMatching('probe.detected'),
            '29 fall-throughs must not trigger the probe alarm yet',
        );
        $this->assertSame(29, RateLimiter::attempts('probe:127.0.0.1'));

        // The 30th hit-then-check fires. With max=30 and HIT-THEN-
        // CHECK, the 30th request itself crosses the threshold
        // because hit() increments first.
        $this->get('/some-unknown-path-30');
        $hits = $this->loggedMatching('probe.detected');
        $this->assertCount(
            1,
            $hits,
            'HIT-THEN-CHECK: the 30th fall-through must trigger the alarm; '
            .'a flip to CHECK-THEN-HIT would push the alarm to the 31st',
        );
        $this->assertSame('warning', $hits[0]['level']);
    }

    #[Test]
    public function probe_alarm_sentinel_caps_log_to_one_per_window(): void
    {
        // Beyond the 30th hit, the sentinel must keep the log line
        // at most once per decay window. Without it, every hit past
        // 30 would log, which on a probing-burst (e.g. 100 req/min
        // from one IP) would 70× amplify the alert into noise.
        $this->seedActiveCover();

        // Drive past the threshold AND then more.
        for ($i = 0; $i < 50; $i++) {
            $this->get('/some-unknown-path-'.$i);
        }
        $hits = $this->loggedMatching('probe.detected');
        $this->assertCount(
            1,
            $hits,
            'sentinel must cap probe.detected to exactly ONE log per decay window '
            .'regardless of how many hits accumulate past the threshold',
        );
    }
}
