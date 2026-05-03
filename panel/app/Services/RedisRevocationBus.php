<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Redis;

// One end of the revocation bridge: the Filament panel writes here
// on every ProxyAccount or ServerConfig save / delete. The Rust
// daemon (ct-server-core daemon) is subscribed on the other end and
// re-renders Caddyfile + reloads Caddy on each message.
//
// Two surfaces, both backed by the same Redis instance the panel
// already uses for cache + queue + sessions:
//
//   1. Pub/sub channel `cool_tunnel:revocations` — the firehose. The
//      Rust daemon's only required input. Each message is a small
//      JSON payload tagged with the event kind.
//
//   2. Steady-state keys `account:status:<username>` — written
//      with the current state ("active", "expired", "revoked") so
//      a future per-request auth hook (custom forwardproxy plugin,
//      v0.1) can consult it without going to MariaDB. Today it's
//      informational.
//
// Latency budget Filament save → Redis publish → Rust daemon
// receives → Caddyfile re-render → admin-socket reload: ≤100 ms in
// the steady state. Network pub/sub itself is sub-millisecond.

final class RedisRevocationBus
{
    public const CHANNEL = 'cool_tunnel:revocations';

    /**
     * Announce that one specific account changed. Use on every save
     * / delete of a ProxyAccount. The reason is free-form ("disabled",
     * "expired", "quota_exceeded", "password_rotated", "deleted") —
     * the daemon doesn't act on the value, but it shows up in the
     * Rust trace log.
     */
    public function announceAccountChanged(string $username, string $reason): void
    {
        $this->publish([
            'kind'     => 'account_changed',
            'username' => $username,
            'reason'   => $reason,
        ]);
    }

    /**
     * Announce a ServerConfig change (anti-tracking toggle, DoH
     * resolver swap, etc.).
     */
    public function announceServerConfigChanged(): void
    {
        $this->publish(['kind' => 'server_config_changed']);
    }

    /** Force a re-render + reload. Useful for the operator's "Sync now" button. */
    public function announceResync(): void
    {
        $this->publish(['kind' => 'resync']);
    }

    /**
     * Maintain the steady-state key. Called from ProxyAccount::saved.
     * The TTL is intentionally absent — these keys live as long as
     * the account does, and we delete them on account deletion.
     */
    public function setAccountStatus(string $username, string $status): void
    {
        try {
            Redis::set("account:status:{$username}", $status);
        } catch (\Throwable $e) {
            Log::warning('redis.account_status.failed', [
                'username' => $username,
                'err'      => $e->getMessage(),
            ]);
        }
    }

    public function clearAccountStatus(string $username): void
    {
        try {
            Redis::del("account:status:{$username}");
        } catch (\Throwable $e) {
            Log::warning('redis.account_status_del.failed', [
                'username' => $username,
                'err'      => $e->getMessage(),
            ]);
        }
    }

    private function publish(array $payload): void
    {
        // Redis pub/sub is best-effort: if the daemon isn't listening
        // (or Redis is down), we don't want to fail the panel save.
        // The panel already calls CaddyfileGenerator + CaddyReloader
        // synchronously as a backstop, so a missed pub/sub costs at
        // most one extra render+reload cycle.
        try {
            Redis::publish(self::CHANNEL, json_encode($payload, JSON_UNESCAPED_SLASHES));
        } catch (\Throwable $e) {
            Log::warning('redis.publish.failed', [
                'channel' => self::CHANNEL,
                'kind'    => $payload['kind'] ?? '?',
                'err'     => $e->getMessage(),
            ]);
        }
    }
}
