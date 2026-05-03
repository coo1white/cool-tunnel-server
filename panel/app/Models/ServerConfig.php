<?php

namespace App\Models;

use App\Services\CaddyReloader;
use App\Services\CaddyfileGenerator;
use Illuminate\Database\Eloquent\Model;

// Singleton — exactly one row, id=1. The seeder creates it on first
// migrate; resource code uses ServerConfig::current() to fetch it.

class ServerConfig extends Model
{
    protected $fillable = [
        'domain', 'acme_email', 'acme_directory',
        'anti_tracking_hide_ip', 'anti_tracking_hide_via',
        'anti_tracking_probe_resistance', 'anti_tracking_doh_resolver',
        'http3_enabled',
        'admin_basic_auth_user', 'admin_basic_auth_hash',
        'last_caddyfile_hash', 'last_rendered_at',
    ];

    protected function casts(): array
    {
        return [
            'anti_tracking_hide_ip'           => 'boolean',
            'anti_tracking_hide_via'          => 'boolean',
            'anti_tracking_probe_resistance'  => 'boolean',
            'http3_enabled'                   => 'boolean',
            'last_rendered_at'                => 'datetime',
        ];
    }

    public static function current(): self
    {
        // firstOrCreate keeps the singleton invariant under concurrent
        // first-boot seeding.
        return static::firstOrCreate(['id' => 1], [
            'domain'         => env('DOMAIN', 'proxy.example.com'),
            'acme_email'     => env('ACME_EMAIL', 'admin@example.com'),
            'acme_directory' => env('ACME_DIRECTORY',
                'https://acme-v02.api.letsencrypt.org/directory'),
        ]);
    }

    protected static function booted(): void
    {
        static::updated(function (): void {
            $generator = app(CaddyfileGenerator::class);
            $hash      = $generator->renderToFile();
            if ($hash !== null) {
                app(CaddyReloader::class)->reload();
            }
        });
    }
}
