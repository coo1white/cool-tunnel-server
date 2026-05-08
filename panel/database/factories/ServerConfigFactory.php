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
            'last_caddyfile_hash' => null,
            'last_rendered_at' => null,
        ];
    }
}
