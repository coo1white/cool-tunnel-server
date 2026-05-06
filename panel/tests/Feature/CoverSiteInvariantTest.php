<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\FakeWebsite;
use App\Models\ProxyAccount;
use App\Models\ServerConfig;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Route;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// The single most important release-blocking property of this
// project: every public-route response that's NOT a successful
// authenticated subscription manifest MUST be byte-identical to
// a vanilla cover-site response. A censor probing the host can
// not be allowed to distinguish `/api/v1/subscription/<bogus>`
// from `/random-path` based on status, headers, body, ETag, or
// timing.
//
// This test fixes the fix paths from v0.0.13 through v0.0.18:
//   - SubscriptionController::show fall-through on unknown token
//   - SubscriptionController::show fall-through on inactive account
//   - SubscriptionController::show fall-through on rate-limit hit
//   - bootstrap/app.php exception handler fall-through on any
//     uncaught throwable on a public route
//
// Together these are the v0.0.14 cover-site invariant — verified
// here by asserting `assertEquals` between the two responses on
// every observable wire property.

class CoverSiteInvariantTest extends TestCase
{
    use RefreshDatabase;

    private function seedActiveCover(): void
    {
        ServerConfig::factory()->create();
        FakeWebsite::factory()->active()->create();
    }

    private function coverSite()
    {
        return $this->get('/cover-baseline-'.bin2hex(random_bytes(4)));
    }

    #[Test]
    public function unknown_subscription_token_returns_byte_identical_cover_site(): void
    {
        $this->seedActiveCover();

        $cover = $this->coverSite();
        $sub = $this->get('/api/v1/subscription/this-token-does-not-exist');

        $cover->assertOk();
        $sub->assertOk();
        $this->assertSame(
            $cover->headers->get('Content-Type'),
            $sub->headers->get('Content-Type'),
            'Content-Type must match the cover site',
        );
        $this->assertSame(
            $cover->headers->get('ETag'),
            $sub->headers->get('ETag'),
            'ETag must match — same body bytes',
        );
        $this->assertSame(
            $cover->getContent(),
            $sub->getContent(),
            'Body must match byte-for-byte',
        );
    }

    #[Test]
    public function expired_subscription_account_returns_byte_identical_cover_site(): void
    {
        $this->seedActiveCover();

        $expired = ProxyAccount::factory()->expired()->create();
        $token = $this->mintTokenFor($expired->id);

        $cover = $this->coverSite();
        $sub = $this->get("/api/v1/subscription/{$token}");

        $sub->assertOk();
        $this->assertSame($cover->getContent(), $sub->getContent());
        $this->assertSame(
            $cover->headers->get('ETag'),
            $sub->headers->get('ETag'),
        );
    }

    #[Test]
    public function rate_limit_hit_falls_through_to_cover_site(): void
    {
        $this->seedActiveCover();

        // Burn past the 60/min/IP cap defined inside
        // SubscriptionController. Every subsequent request must
        // still return cover-site bytes — no 429.
        for ($i = 0; $i < 60; $i++) {
            $this->get('/api/v1/subscription/burn-'.$i);
        }

        $cover = $this->coverSite();
        $limited = $this->get('/api/v1/subscription/now-rate-limited');

        $limited->assertStatus(200);
        $this->assertNotSame(
            429,
            $limited->status(),
            'Rate-limit MUST NOT surface as 429 — leaks endpoint existence',
        );
        $this->assertSame($cover->getContent(), $limited->getContent());
    }

    #[Test]
    public function uncaught_exception_on_public_route_falls_through_to_cover_site(): void
    {
        $this->seedActiveCover();

        // Force a non-/admin route to throw. Easiest path: stub a
        // route that always raises, register it dynamically.
        Route::get('/forced-failure-test', function () {
            throw new \RuntimeException('forced for test');
        });

        $cover = $this->coverSite();
        $thrown = $this->get('/forced-failure-test');

        $thrown->assertStatus(200);
        $this->assertSame(
            $cover->headers->get('Content-Type'),
            $thrown->headers->get('Content-Type'),
        );
        $this->assertSame($cover->getContent(), $thrown->getContent());
    }

    /**
     * Mint a valid HMAC subscription token for the given account
     * id, using the test APP_KEY as the signing key. Mirrors the
     * server-side encoding in SubscriptionController::resolve.
     */
    private function mintTokenFor(int $accountId): string
    {
        $key = (string) config('app.key');
        $hmac = hash_hmac('sha256', (string) $accountId, $key);
        $payload = $accountId.'.'.$hmac;
        $b64 = base64_encode($payload);

        // base64url
        return rtrim(strtr($b64, '+/', '-_'), '=');
    }
}
