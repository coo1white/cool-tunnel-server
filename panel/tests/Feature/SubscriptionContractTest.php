<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\FakeWebsite;
use App\Models\ProxyAccount;
use App\Models\ServerConfig;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// Round-10 client-contract regression tests.
//
// Two silent-failure modes the prior 9 audits didn't catch:
//
//   1. The Rust subscription emitter
//      (core/ct-server-core/src/subscription.rs) emits a
//      literal `{{CLEARTEXT_PLACEHOLDER}}` string the panel was
//      meant to splice cleartext into before signing. The PHP
//      controller path doesn't go through Rust today (it builds
//      the body directly from the model's decrypted column), but
//      a future refactor that pipes Rust→PHP could regress
//      silently — the served body would carry the literal
//      placeholder + clients would 401 against sing-box with no
//      diagnostic. Test #1 anchors that the served body NEVER
//      contains the placeholder string.
//
//   2. Pre-fix the controller served `password => '' ?? ''`
//      when `getCleartextPassword()` returned null — legacy
//      rows pre-v0.0.5 cleartext column, OR Crypt::decryptString
//      failure from APP_KEY rotation. Clients received a
//      valid-looking manifest with empty basic_auth, attempted
//      the proxy connect, and got sing-box 401 — no surface for
//      the operator to debug. Fix: fall through to cover site,
//      preserving the cover-site invariant. Test #2 anchors
//      that contract.

class SubscriptionContractTest extends TestCase
{
    use RefreshDatabase;

    private function seedActiveCover(): void
    {
        ServerConfig::factory()->create();
        FakeWebsite::factory()->active()->create();
    }

    private function coverSiteBaseline()
    {
        return $this->get('/cover-baseline-'.bin2hex(random_bytes(4)));
    }

    #[Test]
    public function served_manifest_never_contains_cleartext_placeholder(): void
    {
        // The Rust emitter emits `{{CLEARTEXT_PLACEHOLDER}}` as
        // a literal — that's its contract for the
        // CLI-without-panel path. The HTTP path must never serve
        // that string to a client. If a future refactor pipes
        // Rust→PHP and forgets to splice, this test catches it.
        $this->seedActiveCover();
        $account = ProxyAccount::factory()->create();
        $account->setCleartextPassword('s3cr3t-actual');
        $account->save();

        $response = $this->get('/api/v1/subscription/'.$account->subscriptionToken());

        $this->assertSame(200, $response->status());
        $this->assertSame('application/json', $response->headers->get('Content-Type'));
        $this->assertStringNotContainsString(
            '{{CLEARTEXT_PLACEHOLDER}}',
            $response->getContent(),
            'Served manifest must never carry the Rust emitter placeholder string',
        );
        $this->assertStringContainsString(
            's3cr3t-actual',
            $response->getContent(),
            'The actual decrypted cleartext should be in the manifest',
        );
    }

    #[Test]
    public function manifest_with_empty_cleartext_falls_through_to_cover_site(): void
    {
        // A row whose cleartext column is empty (or whose
        // decryption fails because APP_KEY rotated since the row
        // was created) MUST NOT serve a working-looking manifest
        // with empty basic_auth. The cover-site fall-through is
        // the right shape: same byte signature as any unknown
        // path, so a censor probing the subscription endpoint
        // can't distinguish "valid token, bad cleartext" from
        // "bogus token" from "/random-path".
        $this->seedActiveCover();
        $account = ProxyAccount::factory()->create();
        // Force the encrypted-cleartext column empty AFTER the
        // factory — the factory normally backfills it via
        // mutators.
        $account->password_cleartext_encrypted = null;
        $account->saveQuietly();

        $cover = $this->coverSiteBaseline();
        $sub = $this->get('/api/v1/subscription/'.$account->subscriptionToken());

        $this->assertSame($cover->status(), $sub->status(), 'status must match cover');
        $this->assertSame(
            $cover->headers->get('Content-Type'),
            $sub->headers->get('Content-Type'),
            'Content-Type must match cover',
        );
        $this->assertSame(
            $cover->getContent(),
            $sub->getContent(),
            'body byte-equal to cover (no manifest leak)',
        );
    }
}
