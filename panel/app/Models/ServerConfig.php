<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Models;

use App\Messages\ReloadServerConfig;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Process;
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
        'reality_private_key', 'reality_public_key',
        'reality_dest_host', 'reality_short_ids',
        'last_caddyfile_hash', 'last_rendered_at',
        'self_probe_history',
    ];

    /**
     * The reality_private_key column carries a sealed secret; never
     * surface it in generic ->toArray() / ->toJson() paths. The
     * renderer reads it explicitly via $cfg->reality_private_key (the
     * `encrypted` cast unwraps it at attribute-access time).
     */
    protected $hidden = [
        'reality_private_key',
    ];

    protected function casts(): array
    {
        return [
            'anti_tracking_hide_ip' => 'boolean',
            'anti_tracking_hide_via' => 'boolean',
            'anti_tracking_probe_resistance' => 'boolean',
            'http3_enabled' => 'boolean',
            // Laravel's `encrypted` cast wraps Crypt::encryptString on
            // write and Crypt::decryptString on read — AES-256-GCM with
            // the panel's APP_KEY. A DB dump alone yields ciphertext;
            // the renderer sees cleartext only at the read boundary.
            'reality_private_key' => 'encrypted',
            'reality_short_ids' => 'array',
            'last_rendered_at' => 'datetime',
            'self_probe_history' => 'array',
        ];
    }

    public static function current(): self
    {
        // firstOrCreate keeps the singleton invariant under concurrent
        // first-boot seeding.
        $cfg = static::firstOrCreate(['id' => 1], [
            'domain' => config('cool-tunnel.domain'),
            'acme_email' => config('cool-tunnel.acme_email'),
            'acme_directory' => config('cool-tunnel.acme_directory'),
        ]);

        if (app()->environment('testing')) {
            return $cfg;
        }

        $cfg->ensureRealityKeypair();

        return $cfg;
    }

    /**
     * First-boot Reality bootstrap. Migration defaults deliberately keep the
     * keypair nullable; this fills it from the bundled singbox-core binary the
     * first time the singleton row is read by seed/render paths.
     */
    public function ensureRealityKeypair(): void
    {
        if (
            (string) ($this->reality_private_key ?? '') !== ''
            && (string) ($this->reality_public_key ?? '') !== ''
        ) {
            return;
        }

        $result = Process::timeout(15)->run(['/usr/local/bin/singbox-core', 'reality-keygen', '--json']);
        if (! $result->successful()) {
            $stderr = trim($result->errorOutput());
            Log::critical('serverconfig.reality_keygen_failed', [
                'exit' => $result->exitCode(),
                'stderr' => substr($stderr, 0, 240),
            ]);

            throw new \RuntimeException(
                'reality keypair generation failed'.
                ($stderr !== '' ? ": {$stderr}" : '')
            );
        }

        try {
            $pair = json_decode(trim($result->output()), true, flags: JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            Log::critical('serverconfig.reality_keygen_non_json', [
                'err' => $e->getMessage(),
            ]);

            throw new \RuntimeException('reality keypair generation returned non-JSON output');
        }

        $private = is_array($pair) ? (string) ($pair['private_key'] ?? '') : '';
        $public = is_array($pair) ? (string) ($pair['public_key'] ?? '') : '';
        if ($private === '' || $public === '') {
            Log::critical('serverconfig.reality_keygen_missing_fields', []);

            throw new \RuntimeException('reality keypair generation returned missing key fields');
        }

        $this->forceFill([
            'reality_private_key' => $private,
            'reality_public_key' => $public,
            'reality_short_ids' => $this->reality_short_ids ?: [''],
        ])->saveQuietly();

        $this->refresh();
    }

    protected static function booted(): void
    {
        // Queue a render after the surrounding transaction commits so
        // a rollback cannot enqueue a phantom reload and the worker
        // cannot read stale state between `updated` and commit.
        static::updated(function (): void {
            DB::afterCommit(function (): void {
                // Catch dispatch failures so a transient queue outage
                // does not bubble out as a 500 — the row is already
                // committed.
                try {
                    app(MessageBusInterface::class)->dispatch(
                        new ReloadServerConfig(reason: 'server_config.updated'),
                    );
                } catch (Throwable $e) {
                    Log::warning('serverconfig.reload.dispatch_failed', [
                        'err' => $e->getMessage(),
                        'type' => $e::class,
                        'note' => 'Messenger bus dispatch failed; row committed but render was not queued. '
                            .'The every-5-min `singbox:render --if-changed` scheduled command will reconcile sing-box.',
                    ]);
                }
            });
        });
    }
}
