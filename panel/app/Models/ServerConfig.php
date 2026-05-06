<?php

declare(strict_types=1);

namespace App\Models;

use App\Services\CaddyfileGenerator;
use App\Services\RedisRevocationBus;
use App\Services\SingBoxConfigGenerator;
use App\Services\SingBoxReloader;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

// Singleton — exactly one row, id=1. The seeder creates it on first
// migrate; resource code uses ServerConfig::current() to fetch it.

class ServerConfig extends Model
{
    use HasFactory;

    protected $fillable = [
        'domain', 'acme_email', 'acme_directory',
        'anti_tracking_hide_ip', 'anti_tracking_hide_via',
        'anti_tracking_probe_resistance', 'anti_tracking_doh_resolver',
        'http3_enabled',
        'last_caddyfile_hash', 'last_rendered_at',
    ];

    protected function casts(): array
    {
        return [
            'anti_tracking_hide_ip' => 'boolean',
            'anti_tracking_hide_via' => 'boolean',
            'anti_tracking_probe_resistance' => 'boolean',
            'http3_enabled' => 'boolean',
            'last_rendered_at' => 'datetime',
        ];
    }

    public static function current(): self
    {
        // firstOrCreate keeps the singleton invariant under concurrent
        // first-boot seeding.
        return static::firstOrCreate(['id' => 1], [
            'domain' => config('cool-tunnel.domain'),
            'acme_email' => config('cool-tunnel.acme_email'),
            'acme_directory' => config('cool-tunnel.acme_directory'),
        ]);
    }

    protected static function booted(): void
    {
        static::updated(function (): void {
            // Same dual-path as ProxyAccount: pub/sub for the ≤100ms
            // hot path, synchronous render+reload as a backstop.
            app(RedisRevocationBus::class)->announceServerConfigChanged();

            // Re-render Caddyfile (Caddy picks the new domain / email
            // up on its own admin-API reload; nothing extra to do
            // from our side besides writing the file). If the operator
            // changed the domain, Caddy will obtain a fresh cert via
            // ACME the next time it boots, and the cert-mtime in our
            // sing-box render hash flips on first renewal.
            app(CaddyfileGenerator::class)->renderToFile();

            // Re-render sing-box and hot-reload via the clash API.
            $singbox = app(SingBoxConfigGenerator::class);
            if ($singbox->renderToFile() !== null) {
                app(SingBoxReloader::class)->reload();
            }
        });
    }
}
