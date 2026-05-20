<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\FakeWebsite;
use App\Models\ProxyAccount;
use App\Models\ServerConfig;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\RateLimiter;

// Emits a SubscriptionManifestV2 for the proxy account whose token
// matches the URL. Signed with HMAC-SHA-256 over the canonical body
// with `signature` ABSENT.
//
// v0.4.0 — the v2 schema replaces v0.3.x's basic-auth manifest with
// sing-box VLESS+Reality fields. Each profile carries:
//
//   { host, port, username, uuid, label, reality: { public_key,
//     dest_host, short_id } }
//
// Reality params live PER PROFILE (rather than at manifest top) so a
// future multi-server / multi-region deployment can hand the client
// distinct Reality fingerprints under one bookmark — the v3.0.0
// client just iterates profiles[] and picks one.
//
// Top-level changes from v1:
//   - `version`: 2 (was 1)
//   - `server_singbox_pin`: carries the upstream sing-box tag the
//     panel container was built against ({"upstream_tag":
//     "v1.13.12"}). The client compares against its own embedded
//     singbox.upstream.json and soft-warns on mismatch. Optional —
//     the controller omits the key when the SingboxPinReader can't
//     shell to singbox-core (degraded deploy; the manifest still
//     works, just no cross-end pin confirmation).
//   - `expires_at`: clamped to FRESHNESS_WINDOW (7 days). Pre-v0.4.0
//     this was 30 days, which exceeded the spec-side replay window
//     and made spec-compliant clients refuse manifests after day 7.
//
// Anti-tracking: response carries NO project-identifying custom
// headers. Signature in the body field, not an X-* header. On the
// wire it looks like any other authenticated JSON API.
//
// Canonical form (must match a future ct-protocol::SubscriptionManifestV2
// when the Rust side gets a v2 deserialiser; until then it's pinned
// by SubscriptionContractTest on the panel side):
//   - Field order: version, server, profiles, capabilities,
//     issued_at, expires_at, note, server_singbox_pin, signature.
//   - Optional fields (`note`, `server_singbox_pin`,
//     `capabilities.fake_site_slug`, `signature`) are OMITTED when
//     null — never emitted as `"key":null`. Emitting `"key":null`
//     diverges from a deserialise→re-serialise round-trip on a
//     spec-compliant client → HMAC mismatch → silent rejection of
//     manifests the server signed correctly.
//   - PHP flags: JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE.
//
// HTTP/3 honesty: the v0.4.0 sing-box stack runs VLESS over TCP only
// (no QUIC listener wired), so `capabilities.http3` is always false.
// Advertising true would lead clients to attempt QUIC, fail, fall
// back — a fingerprintable network pattern.
//
// Why a panel-side endpoint? Historically the cleartext password
// wasn't in the DB; the panel decrypted on-the-fly. v0.4.0 keeps the
// panel-side endpoint for continuity (token-resolution path is
// identical; the cover-site fall-through to FakeSiteController is
// part of the anti-enumeration posture).

class SubscriptionController extends Controller
{
    /**
     * Anti-enumeration rate limit. 60 requests per minute per IP,
     * matching the cap previously expressed by the `subscription`
     * named limiter in AppServiceProvider. We do the check *inside*
     * the controller (rather than via Laravel's `throttle:` middleware)
     * because middleware-driven throttling returns HTTP 429 on hit —
     * which is distinguishable from the 200 cover-site response that
     * the catch-all FakeSiteController serves for any other unmatched
     * URL. A 429 is a strong signal "the subscription endpoint exists
     * here", which defeats the cover-site invariant the rest of this
     * controller goes to lengths to maintain.
     *
     * 60 requests / minute is generous: a legitimate client fetches
     * its manifest at most a few times per day. The cap exists to
     * bound online enumeration of `account_id` (the numeric prefix
     * inside the HMAC-bearing token), not to throttle real users.
     */
    private const RATE_LIMIT_PER_MINUTE = 60;

    private const RATE_LIMIT_DECAY_SEC = 60;

    /**
     * Server-issued manifest expiry, in seconds. Matches the spec-
     * side replay-resistance window (ct-protocol::SubscriptionManifestV1::
     * FRESHNESS_WINDOW_SECONDS = 7 days). Pre-v0.4.0 this was 30 days,
     * which exceeded the spec window: spec-compliant clients refused
     * manifests after day 7 even though the server promised 30, and
     * users saw "subscription stopped working a week after install"
     * with no panel-side error. v0.0.83's `canonical_expires_at`
     * constructor pinned the canonical relationship; this constant
     * matches the same value byte-for-byte. (Round-13 time-and-clock
     * audit; v0.0.83 robustness-review item 6.)
     */
    private const MANIFEST_TTL_SECONDS = 60 * 60 * 24 * 7;

    public function show(Request $request, string $token): Response
    {
        // Single anti-enumeration choke point: ANY failure mode —
        // unknown token, expired account, rate-limit hit, signing-
        // key misconfigured, transient exception in the resolver —
        // returns the same cover-site bytes as a vanilla unknown-
        // path probe. (M-panel-2 + the H1 throttle's anti-enum
        // refinement, both 2026-05-05 audit hotfixes.)
        // RateLimiter ordering note (round-26 cohesion audit): this is
        // CHECK-THEN-HIT, deliberately distinct from the HIT-THEN-CHECK
        // pattern used in FakeSiteController::maybeAlarmOnRapidFall-
        // Through. The semantic difference matters and is intentional:
        //
        //   - CHECK-THEN-HIT (here): with max=60, requests 1..60
        //     succeed; the 61st is blocked. Standard "60 requests per
        //     minute cap" semantics.
        //   - HIT-THEN-CHECK (FakeSite probe alarm): with max=30, the
        //     30th request triggers the alarm — it counts itself
        //     before the threshold check.
        //
        // Don't "normalise" them. A future PR that aligns the two
        // patterns will silently shift one off-by-one in the wrong
        // direction. The boundary is pinned by
        // SubscriptionRateLimiterBoundaryTest.
        $rlKey = 'subscription:'.(string) $request->ip();
        if (RateLimiter::tooManyAttempts($rlKey, self::RATE_LIMIT_PER_MINUTE)) {
            return (new FakeSiteController)->show($request);
        }
        RateLimiter::hit($rlKey, self::RATE_LIMIT_DECAY_SEC);

        try {
            $account = $this->resolve($token);
        } catch (\Throwable $e) {
            // signingKey() throws on empty APP_KEY (M-panel-2). Any
            // other exception in the resolver path also bubbles
            // here — log it loudly so the operator notices in
            // panel logs, but DO NOT leak the failure shape to the
            // probe: the wire response is identical to the cover-
            // site catch-all.
            Log::critical('subscription.resolve.failed', [
                'err' => $e->getMessage(),
                'type' => get_class($e),
            ]);

            return (new FakeSiteController)->show($request);
        }

        if (! $account) {
            // Token didn't resolve to any row. This is the
            // probe-class path (random/expired/forged tokens) —
            // logging once per probe would amplify scanner traffic
            // 1:1 in panel logs (cardinality blow-up at China-bound
            // scan rates). Stay silent here; the cover-site
            // alarm in FakeSiteController::maybeAlarmOnRapidFall-
            // Through aggregates probes per IP per minute.
            return (new FakeSiteController)->show($request);
        }
        if (! $account->isActive()) {
            // Token resolved to a real row, but the account is
            // disabled (operator-toggled, or expired by date).
            // This is a LEGITIMATE user with a working subscription
            // URL who is now seeing "URL stopped working" with no
            // surface — log once per request so the operator can
            // grep `subscription.fallthrough.account_disabled` for
            // "why is user X complaining". Cardinality is bounded
            // by the legitimate-user count, NOT the probe rate.
            // (Round-12 observability.)
            // Username is intentionally omitted — `account_id` is sufficient
            // for operator DB-lookup, and project privacy policy forbids
            // logging usernames (CONTRIBUTING.md "What never gets logged").
            Log::warning('subscription.fallthrough.account_disabled', [
                'account_id' => $account->id,
            ]);

            return (new FakeSiteController)->show($request);
        }

        $cfg = ServerConfig::current();

        // Refuse to emit a manifest with an empty UUID. The booted()
        // `creating` hook on ProxyAccount auto-seeds a UUID at first
        // save, so this branch only fires for legacy rows that
        // somehow predate that hook OR for a corrupt DB column.
        // Falling through to the cover-site preserves the cover-site
        // invariant AND surfaces the failure as an obvious
        // "subscription URL not working" — the operator can debug
        // via the panel's Regenerate-UUID flow.
        $uuid = (string) ($account->uuid ?? '');
        if ($uuid === '') {
            // Active, real account with no UUID set — ALWAYS critical
            // (a row without a credential cannot authenticate against
            // sing-box's vless inbound). Operator must hit the
            // Regenerate-UUID flow for this account. Cardinality is
            // bounded by the broken-account count, not the probe rate.
            Log::critical('subscription.fallthrough.uuid_missing', [
                'account_id' => $account->id,
            ]);

            return (new FakeSiteController)->show($request);
        }

        // Refuse to emit a manifest with no Reality public key.
        // The panel's first-boot SingboxBootstrap is supposed to fill
        // reality_private_key + reality_public_key via
        // `singbox-core reality-keygen`; if those are still empty,
        // the server hasn't been set up and ct-singbox is either not
        // running or running with a default-empty config. A client
        // that received a manifest without `reality.public_key`
        // would have nothing to plug into its sing-box outbound's
        // tls.reality.public_key — the handshake would fail.
        // Falling through to cover-site keeps the same
        // anti-enumeration posture as the other broken-deploy
        // branches in this controller.
        $realityPublicKey = (string) ($cfg->reality_public_key ?? '');
        if ($realityPublicKey === '') {
            Log::critical('subscription.fallthrough.reality_public_key_missing', [
                'account_id' => $account->id,
            ]);

            return (new FakeSiteController)->show($request);
        }

        // Build the body in declaration order so the wire bytes a
        // future Rust client deserialises round-trip byte-for-byte
        // through (deserialise → re-serialise with signature
        // stripped). serde emits struct fields in declaration order;
        // PHP arrays preserve insertion order; the literal here is
        // the source of truth until ct-protocol::SubscriptionManifestV2
        // lands and pins the contract on the spec side.
        //
        // Optional fields are OMITTED when null — never emitted as
        // `"key":null`. A spec-compliant client that strips signature
        // and re-serialises would produce divergent bytes (the
        // dropped optional reappears or doesn't), HMACs diverge,
        // verification fails. The same trap caught a real v0.x bug
        // (the `"note":null` regression) — see Round-11 data-
        // integrity. The `array_filter`-free conditionals below are
        // there so a future maintainer doesn't accidentally insert
        // an `"x" => null` literal.
        $optionalCaps = [];
        if (($slug = optional(FakeWebsite::active())->slug) !== null) {
            $optionalCaps['fake_site_slug'] = $slug;
        }

        // Reality short_id: the first short_id from the configured
        // list, or "" when none configured (the server-side renderer
        // adds `[""]` to the inbound's accepted short_ids in that
        // case — see singbox-core/src/config/render.ts). Future
        // multi-short-id binding (per-account short_id rotation) is
        // a model concern; the manifest just picks one for the
        // client to plug into its outbound.
        // PHPStan can't see through the eloquent-cast type, so spell
        // the narrowing out: array_values renumbers + asserts a
        // list-shaped result; an empty-list check then gives a
        // narrowed array<int,mixed> for the offset read.
        /** @var array<int,mixed> $shortIds */
        $shortIds = is_array($cfg->reality_short_ids)
            ? array_values($cfg->reality_short_ids)
            : [];
        $shortId = $shortIds === [] ? '' : (string) $shortIds[0];

        // Capture wall-clock ONCE for both timestamps. Pre-fix this
        // called `time()` twice in succession on adjacent lines —
        // an extremely rare second-boundary race could land
        // issued_at = N and expires_at = N+1 + TTL = an off-by-one
        // window. (Round-13 time-and-clock audit.)
        $now = time();
        $body = [
            'version' => 2,
            'server' => $cfg->domain,
            'profiles' => [[
                'host' => $cfg->domain,
                'port' => 443,
                'username' => $account->username,
                'uuid' => $uuid,
                'label' => "{$cfg->domain} ({$account->username})",
                'reality' => [
                    'public_key' => $realityPublicKey,
                    'dest_host' => (string) $cfg->reality_dest_host,
                    'short_id' => $shortId,
                ],
            ]],
            'capabilities' => [
                'anti_tracking' => array_values(array_filter([
                    $cfg->anti_tracking_hide_ip ? 'hide_ip' : null,
                    $cfg->anti_tracking_hide_via ? 'hide_via' : null,
                    $cfg->anti_tracking_probe_resistance ? 'probe_resistance' : null,
                    $cfg->anti_tracking_doh_resolver ? 'doh_resolver' : null,
                ])),
                // HTTP/3 always advertised as false — see class
                // docstring. The v0.4.0 sing-box stack runs VLESS
                // over TCP only; no QUIC listener wired.
                'http3' => false,
            ] + $optionalCaps,
            'issued_at' => $now,
            'expires_at' => $now + self::MANIFEST_TTL_SECONDS,
            // note: omitted when null. Today the panel never sets a
            // note; if a future column is added, emit only when non-
            // null and non-empty (NEVER `"note":null` — that breaks
            // canonical round-trip).
        ];

        // HMAC over the body WITHOUT a `signature` field at all.
        // Clients verify by deserialising, setting `signature` to
        // null, and re-serialising in canonical form. We must
        // canonicalise the same way: build and sign with no
        // `signature` key present. Pre-fix (v1) emitted
        // `"signature":null` in the canonical, which DOES NOT round-
        // trip through serde — every Rust-side verification would
        // fail. (Round-11 data-integrity.)
        $canonical = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $body['signature'] = hash_hmac('sha256', $canonical, $this->signingKey());
        $json = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        return response($json, 200)
            ->header('Content-Type', 'application/json')
            ->header('Cache-Control', 'no-store');
    }

    private function resolve(string $token): ?ProxyAccount
    {
        // Token format: base64url("<account_id>.<hmac>"). The hmac is
        // hash_hmac over the account_id with the panel signing key.
        $decoded = base64_decode(strtr($token, '-_', '+/'), true);
        if ($decoded === false || ! str_contains($decoded, '.')) {
            return null;
        }
        [$idStr, $sig] = explode('.', $decoded, 2);
        if (! ctype_digit($idStr)) {
            return null;
        }
        $expected = hash_hmac('sha256', $idStr, $this->signingKey());
        if (! hash_equals($expected, $sig)) {
            return null;
        }

        return ProxyAccount::find((int) $idStr);
    }

    private function signingKey(): string
    {
        $key = (string) config('app.key');
        // Refuse to sign / verify with an empty key. .env.example
        // ships APP_KEY blank; an operator who forgets
        // `php artisan key:generate` would otherwise hash with
        // hash_hmac('sha256', $idStr, '') — deterministic, so every
        // token verifies trivially. Hard-fail rather than silently
        // accept any token. (M-panel-2 in 2026-05-05 audit.)
        if ($key === '') {
            throw new \RuntimeException(
                'APP_KEY is unset; subscription tokens cannot be issued or verified. '
                .'Run `php artisan key:generate` and restart the panel.'
            );
        }

        return $key;
    }
}
