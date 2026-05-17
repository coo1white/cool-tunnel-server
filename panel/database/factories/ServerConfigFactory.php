<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Database\Factories;

use App\Models\ServerConfig;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<ServerConfig>
 */
class ServerConfigFactory extends Factory
{
    protected $model = ServerConfig::class;

    public function definition(): array
    {
        return [
            'domain' => 'test.localhost',
            'acme_email' => 'test@example.com',
            'acme_directory' => 'https://acme-staging-v02.api.letsencrypt.org/directory',
            'anti_tracking_hide_ip' => true,
            'anti_tracking_hide_via' => true,
            'anti_tracking_probe_resistance' => true,
            'anti_tracking_doh_resolver' => 'https://dns.alidns.com/dns-query',
            'http3_enabled' => false,
            // Deterministic Reality keypair for tests. NOT a real X25519
            // keypair — sing-box would reject these at config-load time,
            // but the panel tests assert on emission shape (subscription
            // manifest, render JSON) rather than on actually starting
            // a sing-box process. Realistic-shape stubs keep assertions
            // readable; integration tests that need a valid keypair
            // generate one via `singbox-core reality-keygen`.
            'reality_private_key' => 'TEST-PRIVATE-KEY-base64url-32-byteish',
            'reality_public_key' => 'TEST-PUBLIC-KEY-base64url-32-byteish',
            'reality_dest_host' => 'www.microsoft.com',
            'reality_short_ids' => [''],
            'last_caddyfile_hash' => null,
            'last_rendered_at' => null,
        ];
    }
}
