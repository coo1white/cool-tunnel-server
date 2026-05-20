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

// Round-10 client-contract regression tests, ported to v0.4.0.
//
// v=2 manifest shape (per SubscriptionController head comment):
//
//   {
//     version: 2,
//     server: <domain>,
//     profiles: [{
//       host, port, username, uuid, label,
//       reality: { public_key, dest_host, short_id }
//     }],
//     capabilities: { anti_tracking, http3, ?fake_site_slug },
//     issued_at, expires_at,
//     ?note,
//     ?server_singbox_pin: { upstream_tag },
//     signature: <hex>
//   }
//
// Failure modes that must fall through to the cover-site catch-all
// (preserving anti-enumeration parity with the bogus-token path):
//   - Active account but ProxyAccount.uuid is empty
//   - Active account but ServerConfig.reality_public_key is empty

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
    public function manifest_profile_carries_uuid_and_reality_block(): void
    {
        // v=2 contract: every profile carries the VLESS UUID (the
        // credential) and a per-profile Reality block (public_key +
        // dest_host + short_id). The client plugs these into its
        // sing-box outbound directly.
        $this->seedActiveCover();

        $account = ProxyAccount::factory()->create();
        $uuid = $account->uuid;

        $response = $this->get('/api/v1/subscription/'.$account->subscriptionToken());

        $this->assertSame(200, $response->status());
        $this->assertSame('application/json', $response->headers->get('Content-Type'));

        $decoded = json_decode($response->getContent(), true, flags: JSON_THROW_ON_ERROR);

        $this->assertSame(2, $decoded['version'], 'v0.4.0 manifest version is 2');
        $this->assertCount(1, $decoded['profiles']);

        $profile = $decoded['profiles'][0];
        $this->assertSame($uuid, $profile['uuid'], 'profile.uuid must equal ProxyAccount.uuid');
        $this->assertArrayNotHasKey(
            'password',
            $profile,
            'v=2 manifest must NOT carry v0.3.x `password` field on profiles',
        );

        $this->assertArrayHasKey('reality', $profile, 'profile must carry a reality block');
        $this->assertSame('TEST-PUBLIC-KEY-base64url-32-byteish', $profile['reality']['public_key']);
        $this->assertSame('www.microsoft.com', $profile['reality']['dest_host']);
        $this->assertSame('', $profile['reality']['short_id']);
    }

    #[Test]
    public function manifest_canonical_is_round_trippable(): void
    {
        // Round-11 data-integrity: clients verify by setting
        // `signature` to None and re-canonicalising. With
        // `skip_serializing_if = "Option::is_none"` on Option fields
        // (the future ct-protocol::SubscriptionManifestV2 will mirror
        // V1's serde discipline), absent fields produce JSON with NO
        // key, not `"key":null`.
        //
        // The asserted invariant: the body the SERVER signed equals
        // the body a CLIENT would canonicalise after deserialising
        // and clearing signature.
        $this->seedActiveCover();

        $account = ProxyAccount::factory()->create();

        $response = $this->get('/api/v1/subscription/'.$account->subscriptionToken());
        $this->assertSame(200, $response->status());

        $served = $response->getContent();
        $decoded = json_decode($served, true, flags: JSON_THROW_ON_ERROR);

        $this->assertArrayHasKey('signature', $decoded);
        $servedSig = $decoded['signature'];
        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $servedSig);

        // Strip signature, re-encode with the same flags the
        // controller uses, HMAC, expect equal.
        unset($decoded['signature']);
        $canonical = json_encode(
            $decoded,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR,
        );

        $this->assertStringNotContainsString(
            '"note":',
            $canonical,
            'canonical must omit `note` when null (skip_if_none); emitting '
            .'`"note":null` would diverge from a deserialise→re-serialise '
            .'round-trip and break HMAC verification.',
        );
        $this->assertStringNotContainsString(
            '"signature":',
            $canonical,
            'canonical (post-strip) must NOT carry signature in any form',
        );

        $expected = hash_hmac('sha256', $canonical, (string) config('app.key'));
        $this->assertSame(
            $expected,
            $servedSig,
            'server-signed HMAC must equal the HMAC a client computes by '
            .'removing `signature` and re-canonicalising.',
        );
    }

    #[Test]
    public function manifest_capabilities_skip_optional_when_absent(): void
    {
        // capabilities.fake_site_slug is emitted only when an active
        // fake site exists. When absent it must be OMITTED, not
        // emitted as null — same divergence trap as the top-level
        // `note` field.
        ServerConfig::factory()->create();
        // intentionally NOT creating an active FakeWebsite

        $account = ProxyAccount::factory()->create();

        $response = $this->get('/api/v1/subscription/'.$account->subscriptionToken());
        $this->assertSame(200, $response->status());

        $served = $response->getContent();
        $this->assertStringNotContainsString(
            '"fake_site_slug":null',
            $served,
            'capabilities.fake_site_slug must be omitted when no active fake site, '
            .'not emitted as null — round-trip drops it and HMAC diverges.',
        );

        $decoded = json_decode($served, true, flags: JSON_THROW_ON_ERROR);
        $this->assertArrayNotHasKey('fake_site_slug', $decoded['capabilities']);

        // Sanity: round-trip HMAC still verifies in this branch.
        $sig = $decoded['signature'];
        unset($decoded['signature']);
        $canonical = json_encode(
            $decoded,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR,
        );
        $this->assertSame(
            hash_hmac('sha256', $canonical, (string) config('app.key')),
            $sig,
        );
    }

    #[Test]
    public function manifest_with_non_ascii_label_round_trips_through_hmac_verify(): void
    {
        // Round-14 input-boundary: non-ASCII text in any user-facing
        // field (the `label`, future `note`) must survive the
        // server-canonicalise → HMAC-sign → client-deserialise →
        // re-canonicalise → HMAC-verify round-trip. PHP's
        // JSON_UNESCAPED_UNICODE flag and the client's matching
        // serde_json default both emit raw UTF-8 bytes for non-ASCII;
        // if EITHER encoder flips to default-escape, HMAC verification
        // breaks across every account whose label / domain contains
        // a non-ASCII codepoint.
        //
        // v=2 uuids are ASCII (RFC 4122), so the non-ASCII concern
        // moves to the label field (which embeds the domain).
        ServerConfig::factory()->create(['domain' => 'プロキシ.中文.example']);
        FakeWebsite::factory()->active()->create();

        $account = ProxyAccount::factory()->create();

        $response = $this->get('/api/v1/subscription/'.$account->subscriptionToken());
        $this->assertSame(200, $response->status());

        $served = $response->getContent();

        // Body must contain the raw UTF-8 bytes (NOT \u-escaped).
        $this->assertStringContainsString('プロキシ.中文.example', $served);
        $this->assertStringNotContainsString('\\u30D7', $served, 'no \\u escapes for プ');
        $this->assertStringNotContainsString('\\u4e2d', $served, 'no \\u escapes for 中');

        // HMAC round-trip.
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
            'HMAC must verify with non-ASCII label — if this fails, check that '
            .'JSON_UNESCAPED_UNICODE is still emitted by the controller AND that '
            .'no upstream PHP version change shifted json_encode default behaviour.',
        );
    }

    #[Test]
    public function manifest_issued_at_and_expires_at_are_exactly_7_days_apart(): void
    {
        // Round-13 time-and-clock: pre-fix the controller called
        // `time()` twice on adjacent lines, exposing a sub-second
        // boundary race. Now both share a single captured `$now`.
        //
        // v0.4.0: expires_at - issued_at is the spec's FRESHNESS_WINDOW
        // (7 days), down from v0.3.x's 30 days. Pre-v0.4.0 the server
        // promised 30 days but spec-compliant clients refused after
        // day 7 (the replay-resistance window cut in first). v0.0.83's
        // canonical_expires_at constructor pinned 7 days as the
        // authoritative value; the PHP controller now matches.
        $this->seedActiveCover();

        $account = ProxyAccount::factory()->create();

        $before = time();
        $response = $this->get('/api/v1/subscription/'.$account->subscriptionToken());
        $after = time();
        $this->assertSame(200, $response->status());

        $decoded = json_decode($response->getContent(), true, flags: JSON_THROW_ON_ERROR);

        $this->assertIsInt($decoded['issued_at']);
        $this->assertIsInt($decoded['expires_at']);

        $this->assertGreaterThanOrEqual($before, $decoded['issued_at']);
        $this->assertLessThanOrEqual($after, $decoded['issued_at']);

        $sevenDays = 60 * 60 * 24 * 7;
        $this->assertSame(
            $sevenDays,
            $decoded['expires_at'] - $decoded['issued_at'],
            'expires_at - issued_at must be EXACTLY 7 days '
            .'(matches ct-protocol::SubscriptionManifestV1::FRESHNESS_WINDOW_SECONDS); '
            .'a non-7-day delta means the controller is either calling time() twice '
            .'OR the MANIFEST_TTL_SECONDS constant has drifted from the spec value.',
        );
    }

    #[Test]
    public function manifest_with_empty_uuid_falls_through_to_cover_site(): void
    {
        // A row whose uuid column is empty (corrupt DB row, or a
        // legacy migration that didn't auto-seed) MUST NOT serve a
        // working-looking manifest with no credential. The cover-site
        // fall-through is the right shape: same byte signature as any
        // unknown path, so a censor probing the subscription endpoint
        // can't distinguish "valid token, no credential" from "bogus
        // token" from "/random-path".
        $this->seedActiveCover();

        $account = ProxyAccount::factory()->create();
        // Bypass the creating-hook by zeroing the column directly.
        $account->uuid = '';
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

    #[Test]
    public function manifest_with_empty_reality_public_key_falls_through_to_cover_site(): void
    {
        // ServerConfig.reality_public_key empty → operator hasn't run
        // first-boot reality-keygen, or the column got nulled. A
        // manifest without reality.public_key would carry a credential
        // the client can't actually use. Fall-through to cover-site,
        // same posture as the uuid-missing branch.
        ServerConfig::factory()->create(['reality_public_key' => '']);
        FakeWebsite::factory()->active()->create();

        $account = ProxyAccount::factory()->create();

        $cover = $this->coverSiteBaseline();
        $sub = $this->get('/api/v1/subscription/'.$account->subscriptionToken());

        $this->assertSame($cover->status(), $sub->status());
        $this->assertSame(
            $cover->headers->get('Content-Type'),
            $sub->headers->get('Content-Type'),
        );
        $this->assertSame($cover->getContent(), $sub->getContent());
    }
}
