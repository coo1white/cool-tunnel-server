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
// field set to null). On the wire this looks like any other
// authenticated JSON API response, not a "Cool Tunnel" tell.
// (v0.0.8 and earlier emitted X-CT-Signature / X-CT-Protocol
// response headers; those are gone.)
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

    public function show(Request $request, string $token): Response
    {
        // Single anti-enumeration choke point: ANY failure mode —
        // unknown token, expired account, rate-limit hit, signing-
        // key misconfigured, transient exception in the resolver —
        // returns the same cover-site bytes as a vanilla unknown-
        // path probe. (M-panel-2 + the H1 throttle's anti-enum
        // refinement, both 2026-05-05 audit hotfixes.)
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

        if (! $account || ! $account->isActive()) {
            // Forward to the cover-site catch-all so an invalid /
            // expired subscription URL returns the same bytes (body
            // shape, status, headers) as any other unmatched path.
            // Returning a short empty body — even with text/html —
            // would distinguish a bogus /subscription/<token> from a
            // regular cover-site path purely by Content-Length.
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
            return (new FakeSiteController)->show($request);
        }

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
                'fake_site_slug' => optional(FakeWebsite::active())->slug,
            ],
            'issued_at' => time(),
            'expires_at' => time() + 60 * 60 * 24 * 30,
            'note' => null,
            'signature' => null, // placeholder; signed below
        ];

        // Compute HMAC over the canonical body with `signature`
        // set to null, then splice the hex digest back in. Verifies
        // identically on the client without needing the original
        // field order — clients re-canonicalise (set signature to
        // null, re-serialise) before checking.
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
