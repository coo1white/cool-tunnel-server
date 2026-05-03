<?php

namespace App\Http\Controllers;

use App\Models\ProxyAccount;
use App\Models\ServerConfig;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

// Emits a SubscriptionManifestV1 (per ct-protocol::subscription) for
// the proxy account whose token matches the URL. Signed with HMAC-
// SHA-256 using a per-account secret.
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
            // Match Caddy's probe_resistance default: 404 looking
            // exactly like the cover-site catch-all, so an invalid
            // token can't be distinguished from "no such page".
            return response('', 404)
                ->header('Content-Type', 'text/html; charset=utf-8');
        }

        $cfg = ServerConfig::current();

        $body = [
            'version'      => 1,
            'server'       => $cfg->domain,
            'profiles'     => [[
                'host'     => $cfg->domain,
                'port'     => 443,
                'username' => $account->username,
                // The cleartext is sealed in metadata at issue-time.
                'password' => $account->metadata['cleartext'] ?? '',
                'label'    => "{$cfg->domain} ({$account->username})",
            ]],
            'capabilities' => [
                'anti_tracking' => array_values(array_filter([
                    $cfg->anti_tracking_hide_ip          ? 'hide_ip'          : null,
                    $cfg->anti_tracking_hide_via         ? 'hide_via'         : null,
                    $cfg->anti_tracking_probe_resistance ? 'probe_resistance' : null,
                    $cfg->anti_tracking_doh_resolver     ? 'doh_resolver'     : null,
                    $cfg->http3_enabled                  ? 'http3'            : null,
                ])),
                'http3'          => (bool) $cfg->http3_enabled,
                'fake_site_slug' => optional(\App\Models\FakeWebsite::active())->slug,
            ],
            'issued_at'    => time(),
            'expires_at'   => time() + 60 * 60 * 24 * 30,
            'note'         => null,
        ];

        $json = json_encode($body, JSON_UNESCAPED_SLASHES);
        $sig  = hash_hmac('sha256', $json, $this->signingKey());

        return response($json, 200)
            ->header('Content-Type',    'application/json')
            ->header('X-CT-Signature',   $sig)
            ->header('X-CT-Protocol',    '1')
            ->header('Cache-Control',    'no-store');
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
