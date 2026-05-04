<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\ProxyAccount;
use App\Models\ServerConfig;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

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
    public function show(Request $request, string $token): Response
    {
        // Resolve the token: it's an HMAC-SHA-256 of the proxy_account
        // id + a panel-wide secret, presented base64url-encoded.
        $account = $this->resolve($token);
        if (! $account || ! $account->isActive()) {
            // Forward to the cover-site catch-all so an invalid /
            // expired subscription URL returns the same bytes (body
            // shape, status, headers) as any other unmatched path.
            // Returning a short empty body — even with text/html —
            // would distinguish a bogus /subscription/<token> from a
            // regular cover-site path purely by Content-Length.
            return (new FakeSiteController())->show($request);
        }

        $cfg = ServerConfig::current();

        $body = [
            'version'      => 1,
            'server'       => $cfg->domain,
            'profiles'     => [[
                'host'     => $cfg->domain,
                'port'     => 443,
                'username' => $account->username,
                'password' => $account->getCleartextPassword() ?? '',
                'label'    => "{$cfg->domain} ({$account->username})",
            ]],
            'capabilities' => [
                'anti_tracking' => array_values(array_filter([
                    $cfg->anti_tracking_hide_ip          ? 'hide_ip'          : null,
                    $cfg->anti_tracking_hide_via         ? 'hide_via'         : null,
                    $cfg->anti_tracking_probe_resistance ? 'probe_resistance' : null,
                    $cfg->anti_tracking_doh_resolver     ? 'doh_resolver'     : null,
                ])),
                // HTTP/3 always advertised as false — see class
                // docstring. NaiveProxy does not do QUIC.
                'http3'          => false,
                'fake_site_slug' => optional(\App\Models\FakeWebsite::active())->slug,
            ],
            'issued_at'    => time(),
            'expires_at'   => time() + 60 * 60 * 24 * 30,
            'note'         => null,
            'signature'    => null, // placeholder; signed below
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
        return (string) config('app.key');
    }
}
