<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\FakeWebsite;
use App\Models\ProxyAccount;
use App\Models\ServerConfig;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\RateLimiter;

// Emits a SubscriptionManifestV1 (per ct-protocol::subscription) for
// the proxy account whose token matches the URL. Signed with HMAC-
// SHA-256 using a per-account secret.
//
// Anti-tracking note: the response carries NO project-identifying
// custom headers. The signature rides in the JSON body's
// `signature` field (computed over the canonical body with that
// field ABSENT — see the canonical-form note below; pre-v0.0.59
// docs said "set to null" but that did not match the Rust spec
// and broke client-side verification). On the wire this looks
// like any other authenticated JSON API response, not a "Cool
// Tunnel" tell. (v0.0.8 and earlier emitted X-CT-Signature /
// X-CT-Protocol response headers; those are gone.)
//
// Canonical form (v0.0.59+, must match
// core/ct-protocol/src/subscription.rs serde behaviour):
//   - Field order = SubscriptionManifestV1 declaration order:
//     version, server, profiles, capabilities, issued_at,
//     expires_at, note, signature.
//   - Optional fields with `skip_serializing_if = "Option::is_none"`
//     on the Rust side are emitted ONLY when set: `note` (top
//     level) and `capabilities.fake_site_slug`. Emitting them as
//     `"key":null` in the canonical breaks Rust-client verification
//     (the client deserialises null → None → drops the key on
//     re-canonicalise → bytes diverge → HMAC fails).
//   - The signature itself is NOT in the canonical at all (NOT
//     present-as-null). The server builds the body without a
//     signature key, HMACs those bytes, then adds the signature
//     key for the response body only.
//   - PHP flags: JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE.
//   - The contract is pinned by SubscriptionContractTest +
//     ct-protocol's canonical_roundtrips_under_signature_strip.
//
// HTTP/3 honesty: NaiveProxy is HTTP/2-only at the protocol level,
// so the manifest's `capabilities.http3` is always false regardless
// of any DB toggle. Advertising true would lead clients to attempt
// QUIC, fail (no UDP listener), and fall back — a recognisable
// network signature. See cross-platform-clients.md.
//
// Why a panel-side endpoint and not just `ct-server-core subscription`?
// The cleartext password isn't in the DB (we only store the bcrypt
// hash). The panel issues a one-time token at account creation that
// also stores the cleartext encrypted with the HMAC secret; this
// controller resolves the token, decrypts, splices the cleartext
// into the manifest the Rust core emits, signs the body, and serves.

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
     * Server-issued manifest expiry, in seconds. The Rust spec
     * (ct-protocol::SubscriptionManifestV1::FRESHNESS_WINDOW_SECONDS)
     * also enforces a 7-day replay window measured from issued_at —
     * so even though we issue a 30-day expires_at here, a captured
     * manifest is only usable for 7 days regardless. The 30-day
     * value is what the operator chose for "how often a healthy
     * client must re-fetch". Don't bump this above 30 days without
     * coordinating with the FRESHNESS_WINDOW_SECONDS bound (the
     * client will reject earlier than the server-issued expiry).
     * (Round-13 time-and-clock audit.)
     */
    private const MANIFEST_TTL_SECONDS = 60 * 60 * 24 * 30;

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
            Log::warning('subscription.fallthrough.account_disabled', [
                'account_id' => $account->id,
                'username' => $account->username,
            ]);

            return (new FakeSiteController)->show($request);
        }

        $cfg = ServerConfig::current();

        // Refuse to emit a manifest with an empty cleartext
        // password. Pre-fix the controller served `password => ''`
        // when getCleartextPassword() returned null (legacy row
        // pre-v0.0.5 cleartext column, or a Crypt::decryptString
        // failure from APP_KEY rotation — see ProxyAccount.php:
        // 192-202). The client would receive a valid-looking
        // manifest, attempt the proxy connect with empty
        // basic_auth, and get a sing-box 401 with no diagnostic
        // surface. Falling through to the cover-site preserves
        // the cover-site invariant AND surfaces the failure as
        // an obvious "subscription URL not working" — the
        // operator can debug via the panel's Regenerate-password
        // flow. (Round-10 client-contract audit.)
        $cleartext = $account->getCleartextPassword();
        if ($cleartext === null || $cleartext === '') {
            // Active, real account with a broken cleartext column —
            // ALWAYS critical (this means an APP_KEY rotation or
            // legacy-row issue is silently breaking THIS specific
            // user's subscription). Operator must hit the
            // Regenerate-password flow for this account. Cardinality
            // is bounded by the broken-account count, not the probe
            // rate. (Round-12 observability.)
            Log::critical('subscription.fallthrough.cleartext_decrypt_failed', [
                'account_id' => $account->id,
                'username' => $account->username,
            ]);

            return (new FakeSiteController)->show($request);
        }

        // Build the body in field-declaration order of
        // SubscriptionManifestV1 (core/ct-protocol/src/subscription.rs):
        // version, server, profiles, capabilities, issued_at,
        // expires_at, note, signature. serde emits struct fields in
        // declaration order; PHP arrays preserve insertion order; so
        // the on-the-wire byte order is the same on both sides as
        // long as we keep the literal below in sync with the Rust
        // struct.
        //
        // Optional fields with `#[serde(skip_serializing_if =
        // "Option::is_none")]` on the Rust side MUST be OMITTED here
        // when null — `serde_json::to_string(&m)` on a struct whose
        // `note` is None produces JSON without a `note` key at all.
        // If we emit `"note":null`, the Rust client deserialises ↦
        // `note: None`, then re-canonicalises (signature = None) and
        // gets DIFFERENT bytes (no `note` key). HMACs diverge.
        // Verification fails on a manifest the server signed
        // correctly. Same trap for `capabilities.fake_site_slug`
        // when no fake site is active. (Round-11 data-integrity.)
        $optionalCaps = [];
        if (($slug = optional(FakeWebsite::active())->slug) !== null) {
            $optionalCaps['fake_site_slug'] = $slug;
        }

        // Capture wall-clock ONCE for both timestamps. Pre-fix this
        // called `time()` twice in succession on adjacent lines —
        // an extremely rare second-boundary race could land
        // issued_at = N and expires_at = N+1 + 30 days = an
        // off-by-one window. The MANIFEST_TTL_SECONDS constant
        // matches ct-protocol::SubscriptionManifestV1::FRESHNESS_-
        // WINDOW_SECONDS-aware design: server emits a 30-day
        // expires_at; the client's spec-side replay-resistance
        // window cuts in earlier at 7 days. (Round-13 time-and-
        // clock audit.)
        $now = time();
        $body = [
            'version' => 1,
            'server' => $cfg->domain,
            'profiles' => [[
                'host' => $cfg->domain,
                'port' => 443,
                'username' => $account->username,
                'password' => $cleartext,
                'label' => "{$cfg->domain} ({$account->username})",
            ]],
            'capabilities' => [
                'anti_tracking' => array_values(array_filter([
                    $cfg->anti_tracking_hide_ip ? 'hide_ip' : null,
                    $cfg->anti_tracking_hide_via ? 'hide_via' : null,
                    $cfg->anti_tracking_probe_resistance ? 'probe_resistance' : null,
                    $cfg->anti_tracking_doh_resolver ? 'doh_resolver' : null,
                ])),
                // HTTP/3 always advertised as false — see class
                // docstring. NaiveProxy does not do QUIC.
                'http3' => false,
            ] + $optionalCaps,
            'issued_at' => $now,
            'expires_at' => $now + self::MANIFEST_TTL_SECONDS,
            // note: omitted when null (Rust skip_if_none). Today the
            // panel never sets a note; if a future column is added,
            // emit only when non-null and non-empty.
        ];

        // HMAC over the body WITHOUT a `signature` field at all.
        // The Rust client verifies by deserialising, setting
        // `signature` to None, and re-serialising — which produces
        // bytes with no `signature` key (skip_if_none). We must
        // canonicalise the same way: build and sign with no
        // `signature` key present. Pre-fix this code emitted
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
