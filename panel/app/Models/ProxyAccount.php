<?php

namespace App\Models;

use App\Services\CaddyReloader;
use App\Services\CaddyfileGenerator;
use App\Services\RedisRevocationBus;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

// One row per proxy user.
//
// Anytime an account is created, edited, or deleted we re-render the
// Caddyfile and ask Caddy to hot-reload. The actual work runs through
// a queue job so a slow reload doesn't block the admin's request.

class ProxyAccount extends Model
{
    use HasFactory;

    protected $fillable = [
        'username', 'password_hash', 'label', 'enabled',
        'quota_bytes', 'used_bytes', 'expires_at', 'last_seen_at',
        'metadata',
    ];

    protected function casts(): array
    {
        return [
            'enabled'       => 'boolean',
            'quota_bytes'   => 'integer',
            'used_bytes'    => 'integer',
            'expires_at'    => 'datetime',
            'last_seen_at'  => 'datetime',
            'metadata'      => 'array',
        ];
    }

    public function trafficLogs(): HasMany
    {
        return $this->hasMany(TrafficLog::class);
    }

    /** Whether the account is currently considered active by Caddy. */
    public function isActive(): bool
    {
        if (! $this->enabled)                                    return false;
        if ($this->expires_at && $this->expires_at->isPast())    return false;
        if ($this->quota_bytes && $this->used_bytes >= $this->quota_bytes) return false;
        return true;
    }

    protected static function booted(): void
    {
        // Any change to the basic_auth set means we need a new
        // Caddyfile. Two paths fire in sequence:
        //
        //   1. Redis pub/sub → ct-server-core daemon picks it up
        //      within ~1ms and re-renders + reloads. This is the
        //      ≤100ms hot path the operator-facing UI cares about.
        //
        //   2. A synchronous PHP-side render+reload as a backstop in
        //      case Redis is unreachable or the daemon isn't running.
        //      Both layers dedupe by SHA-256 so a duplicate reload is
        //      a no-op.
        //
        // The order matters: we publish first so the Rust daemon can
        // start the work in parallel with whatever the panel's PHP
        // backstop is doing.

        static::saved(function (self $account): void {
            $bus    = app(RedisRevocationBus::class);
            $status = $account->isActive() ? 'active'
                    : ($account->expires_at && $account->expires_at->isPast() ? 'expired' : 'revoked');
            $bus->setAccountStatus($account->username, $status);
            $bus->announceAccountChanged($account->username, "saved:{$status}");

            $generator = app(CaddyfileGenerator::class);
            $hash      = $generator->renderToFile();
            if ($hash !== null) {
                app(CaddyReloader::class)->reload();
            }
        });

        static::deleted(function (self $account): void {
            $bus = app(RedisRevocationBus::class);
            $bus->clearAccountStatus($account->username);
            $bus->announceAccountChanged($account->username, 'deleted');

            $generator = app(CaddyfileGenerator::class);
            $hash      = $generator->renderToFile();
            if ($hash !== null) {
                app(CaddyReloader::class)->reload();
            }
        });
    }
}
