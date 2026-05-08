<?php
// SPDX-License-Identifier: AGPL-3.0-only

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
    public function manifest_canonical_is_serde_round_trippable(): void
    {
        // Round-11 data-integrity: the contract docstring on
        // SubscriptionManifestV1 (core/ct-protocol/src/subscription.rs)
        // says clients verify by setting `signature` to None and
        // re-serialising. With serde's `skip_serializing_if =
        // "Option::is_none"` on Option<String> fields, an absent
        // None field produces JSON with NO key, not `"key":null`.
        //
        // Pre-fix the controller emitted `"note":null` and
        // `"signature":null` literals in the canonical body. Round-
        // tripping THAT through a Rust deserialise + (signature →
        // None) + re-serialise produces a SHORTER string (no `note`
        // key, no `signature` key) — different bytes, different
        // HMAC, every Rust client verification fails.
        //
        // This test asserts the served JSON survives a remove-
        // signature round-trip without losing or gaining keys —
        // i.e. the bytes the SERVER signed equal the bytes a CLIENT
        // would canonicalise. PHP's `json_encode` and `json_decode`
        // round-trip is byte-stable for our flag set (UNESCAPED_-
        // SLASHES | UNESCAPED_UNICODE) and the rest of the body
        // contains only flat scalars + ordered arrays — same shape
        // serde produces.
        $this->seedActiveCover();
        $account = ProxyAccount::factory()->create();
        $account->setCleartextPassword('s3cr3t-actual');
        $account->save();

        $response = $this->get('/api/v1/subscription/'.$account->subscriptionToken());
        $this->assertSame(200, $response->status());

        $served = $response->getContent();
        $decoded = json_decode($served, true, flags: JSON_THROW_ON_ERROR);

        $this->assertArrayHasKey('signature', $decoded, 'served manifest must carry a signature');
        $servedSig = $decoded['signature'];
        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $servedSig, 'signature must be 32-byte hex');

        // Reconstruct the canonical: drop `signature` entirely
        // (matching `signature: None` + skip_if_none on the Rust
        // side). Re-encode with the same flags the controller uses.
        unset($decoded['signature']);
        $canonical = json_encode(
            $decoded,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR,
        );

        // The body must NOT contain `note` when it is null —
        // pre-fix this test would catch `"note":null` leaking into
        // canonical bytes.
        $this->assertStringNotContainsString(
            '"note":',
            $canonical,
            'canonical must omit `note` when null (Rust skip_if_none); '
            .'leaking `"note":null` into the canonical breaks HMAC verification',
        );
        $this->assertStringNotContainsString(
            '"signature":',
            $canonical,
            'canonical (post-strip) must NOT carry signature in any form',
        );

        // HMAC the reconstructed canonical with the same key the
        // controller used — must equal the served signature. This
        // is the EXACT computation a Rust/Go/Swift client does;
        // if it diverges, that client cannot verify a manifest
        // this server signs.
        $expected = hash_hmac('sha256', $canonical, (string) config('app.key'));
        $this->assertSame(
            $expected,
            $servedSig,
            'server-signed HMAC must equal the HMAC a client would compute by '
            .'removing `signature` and re-canonicalising — '
            .'if this fails, every client implementing the documented '
            .'verify-by-stripping-signature flow will reject this manifest',
        );
    }

    #[Test]
    public function manifest_capabilities_skip_optional_when_absent(): void
    {
        // capabilities.fake_site_slug carries
        // `#[serde(default, skip_serializing_if = "Option::is_none")]`
        // on the Rust side. When no fake site is active, the field
        // must be ABSENT from the canonical, not present-as-null.
        // Pre-fix the controller emitted
        // `"fake_site_slug":null` always — same divergence trap as
        // the top-level `note` field.
        ServerConfig::factory()->create();
        // intentionally NOT creating an active FakeWebsite

        $account = ProxyAccount::factory()->create();
        $account->setCleartextPassword('s3cr3t-actual');
        $account->save();

        $response = $this->get('/api/v1/subscription/'.$account->subscriptionToken());
        $this->assertSame(200, $response->status());

        $served = $response->getContent();
        $this->assertStringNotContainsString(
            '"fake_site_slug":null',
            $served,
            'capabilities.fake_site_slug must be omitted when no active fake site, '
            .'not emitted as null — Rust round-trip drops it and HMAC diverges',
        );

        $decoded = json_decode($served, true, flags: JSON_THROW_ON_ERROR);
        $this->assertArrayNotHasKey('fake_site_slug', $decoded['capabilities']);

        // Sanity: the round-trip HMAC still verifies in this branch.
        $sig = $decoded['signature'];
        unset($decoded['signature']);
        $canonical = json_encode(
            $decoded,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR,
        );
        $this->assertSame(
            hash_hmac('sha256', $canonical, (string) config('app.key')),
            $sig,
            'HMAC must verify in the no-active-fake-site branch too',
        );
    }

    #[Test]
    public function manifest_with_non_ascii_password_round_trips_through_hmac_verify(): void
    {
        // Round-14 input-boundary: non-ASCII passwords (Chinese,
        // Japanese, Korean, anything non-ASCII) must survive the
        // server-canonicalise → HMAC-sign → client-deserialise →
        // re-canonicalise → HMAC-verify round-trip.
        //
        // Pre-this test, the contract relied on PHP's
        // JSON_UNESCAPED_UNICODE flag matching Rust's serde_json
        // default — both emit raw UTF-8 bytes for non-ASCII. If
        // EITHER encoder ever flips to default-escape, the
        // canonical bytes diverge and HMAC verification fails on
        // every account whose password contains a non-ASCII
        // codepoint. This test exercises the actual PHP encode
        // path and proves the round-trip succeeds in the
        // non-ASCII case (the analogous Rust-side test is in
        // ct-protocol::subscription::tests).
        $this->seedActiveCover();
        $account = ProxyAccount::factory()->create();
        $account->setCleartextPassword('héllo Zürich プロキシ 中文密码');
        $account->save();

        $response = $this->get('/api/v1/subscription/'.$account->subscriptionToken());
        $this->assertSame(200, $response->status());

        $served = $response->getContent();

        // Body must contain the raw UTF-8 bytes (NOT \u-escaped).
        $this->assertStringContainsString('héllo Zürich', $served);
        $this->assertStringContainsString('プロキシ', $served);
        $this->assertStringContainsString('中文密码', $served);
        $this->assertStringNotContainsString('\\u00e9', $served, 'no \\u escapes for é');
        $this->assertStringNotContainsString('\\u4e2d', $served, 'no \\u escapes for 中');

        // HMAC round-trip must succeed in the non-ASCII branch
        // (same recipe as manifest_canonical_is_serde_round_trippable
        // but with non-ASCII payload).
        $decoded = json_decode($served, true, flags: JSON_THROW_ON_ERROR);
        $sig = $decoded['signature'];
        unset($decoded['signature']);
        $canonical = json_encode(
            $decoded,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR,
        );
        $this->assertSame(
            hash_hmac('sha256', $canonical, (string) config('app.key')),
            $sig,
            'HMAC must verify with non-ASCII password — if this fails, '
            .'check that PHP JSON_UNESCAPED_UNICODE is still emitted by the '
            .'controller AND that no upstream PHP version change shifted '
            .'json_encode default behaviour',
        );
    }

    #[Test]
    public function manifest_issued_at_and_expires_at_are_exactly_30_days_apart(): void
    {
        // Round-13 time-and-clock: pre-fix the controller called
        // `time()` twice on adjacent lines for issued_at and
        // expires_at, which under a sub-second second-boundary
        // race could land issued_at = N and expires_at = N+1 + 30
        // days — an off-by-one window. Now both share a single
        // captured `$now`. This test pins:
        //   1. expires_at - issued_at == EXACTLY 30 days
        //   2. issued_at <= the test's wall clock (reasonable
        //      sanity bound)
        //
        // Anchors against the Rust spec's
        // FRESHNESS_WINDOW_SECONDS = 7 days: the server-issued
        // expiry is 30 days but client-side replay-resistance
        // cuts in at 7 days. If a future change pushes
        // MANIFEST_TTL_SECONDS above 30 days, this test fails
        // first — at which point the FRESHNESS_WINDOW_SECONDS
        // bound on the client side becomes the binding constraint
        // and the operator should know.
        $this->seedActiveCover();
        $account = ProxyAccount::factory()->create();
        $account->setCleartextPassword('s3cr3t');
        $account->save();

        $before = time();
        $response = $this->get('/api/v1/subscription/'.$account->subscriptionToken());
        $after = time();
        $this->assertSame(200, $response->status());

        $decoded = json_decode($response->getContent(), true, flags: JSON_THROW_ON_ERROR);

        $this->assertIsInt($decoded['issued_at']);
        $this->assertIsInt($decoded['expires_at']);

        $this->assertGreaterThanOrEqual(
            $before,
            $decoded['issued_at'],
            'issued_at must be >= the pre-request wall clock',
        );
        $this->assertLessThanOrEqual(
            $after,
            $decoded['issued_at'],
            'issued_at must be <= the post-request wall clock',
        );

        $thirtyDays = 60 * 60 * 24 * 30;
        $this->assertSame(
            $thirtyDays,
            $decoded['expires_at'] - $decoded['issued_at'],
            'expires_at - issued_at must be EXACTLY 30 days; '
            .'a non-30-day delta means the controller is calling time() '
            .'twice and racing the second boundary',
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
