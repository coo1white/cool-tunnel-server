<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Models;

use App\Jobs\ReloadServerConfigJob;
use App\Services\RedisRevocationBus;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
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
        static::updated(function (): void {
            // Same dual-path as ProxyAccount: Redis pub/sub for the
            // ≤100ms hot path, queued render+reload as the slow-path
            // backstop. v0.0.84 robustness-review fix (item 7) moved
            // the slow path into ReloadServerConfigJob — pre-fix
            // both renders + the clash-API reload ran inline inside
            // the Filament request lifecycle, blocking the Octane
            // worker for the full 60s ct-server-core subprocess
            // timeout on every transient hang while the operator
            // saw an unconditional "saved successfully" notification.
            //
            // DB::afterCommit defers both the Redis announce and
            // the job dispatch until the surrounding transaction
            // (Filament's save action) commits — without it the
            // queue worker could pick up the job between the
            // `static::updated` callback and the transaction
            // commit and read stale state.
            DB::afterCommit(function (): void {
                // Fast path. Fire-and-forget; failure is logged at
                // warn inside the bus and does not surface to the
                // request — the slow-path job below is the
                // consistency layer.
                app(RedisRevocationBus::class)->announceServerConfigChanged();

                // Slow-path backstop: queued job that re-renders
                // Caddyfile + sing-box config and hot-reloads
                // sing-box. The job is hash-idempotent and safe
                // to run twice.
                //
                // Wrap dispatch in try/catch so a transient queue
                // outage (Redis down — both the queue and the
                // pub/sub bus share the same Redis backend in the
                // shipped .env) doesn't bubble out as a 500 to
                // the Filament request. The DB row is already
                // committed; surface the failure at warn so the
                // operator sees it without losing the row.
                try {
                    ReloadServerConfigJob::dispatch();
                } catch (Throwable $e) {
                    Log::warning('serverconfig.reload.dispatch_failed', [
                        'err' => $e->getMessage(),
                        'type' => get_class($e),
                        'note' => 'queue dispatch failed; row committed but slow-path render+reload was not queued. '
                            .'Redis fast-path (if Redis is up) is unaffected; the every-5-min '
                            .'`singbox:render --if-changed --reload` scheduled command will reconcile.',
                    ]);
                }
            });
        });
    }
}
