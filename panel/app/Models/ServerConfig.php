<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Models;

use App\Messages\ReloadServerConfig;
use App\Services\RedisRevocationBus;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Messenger\MessageBusInterface;
use Throwable;

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
        'self_probe_history',
    ];

    protected function casts(): array
    {
        return [
            'anti_tracking_hide_ip' => 'boolean',
            'anti_tracking_hide_via' => 'boolean',
            'anti_tracking_probe_resistance' => 'boolean',
            'http3_enabled' => 'boolean',
            'last_rendered_at' => 'datetime',
            'self_probe_history' => 'array',
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
        // Dual-path on update: Redis pub/sub (≤100ms hot path) plus
        // ReloadServerConfig Messenger message (slow-path render+reload
        // backstop). Both run via DB::afterCommit so a rollback in the
        // surrounding Filament transaction doesn't queue a phantom
        // reload, and the worker can't read stale state between
        // `updated` and commit. See CHANGELOG [0.0.84] (original
        // queue-job design) + [0.0.94] (Messenger cutover).
        static::updated(function (): void {
            DB::afterCommit(function (): void {
                app(RedisRevocationBus::class)->announceServerConfigChanged();

                // Catch dispatch failures (Redis backs both the
                // Messenger transport and the pub/sub bus in the
                // shipped .env) so a transient outage doesn't bubble
                // out as a 500 — the row is already committed.
                try {
                    app(MessageBusInterface::class)->dispatch(
                        new ReloadServerConfig(reason: 'server_config.updated'),
                    );
                } catch (Throwable $e) {
                    Log::warning('serverconfig.reload.dispatch_failed', [
                        'err' => $e->getMessage(),
                        'type' => $e::class,
                        'note' => 'Messenger bus dispatch failed; row committed but slow-path render+reload was not queued. '
                            .'Redis fast-path (if Redis is up) is unaffected; the every-5-min '
                            .'`singbox:render --if-changed --reload` scheduled command will reconcile.',
                    ]);
                }
            });
        });
    }
}
