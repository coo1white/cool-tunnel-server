<?php

namespace App\Models;

use App\Services\CaddyReloader;
use App\Services\CaddyfileGenerator;
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
        // Caddyfile. The Generator + Reloader services dedupe by
        // hash, so churn is fine.
        $reload = function (): void {
            $generator = app(CaddyfileGenerator::class);
            $hash      = $generator->renderToFile();
            if ($hash !== null) {
                app(CaddyReloader::class)->reload();
            }
        };

        static::saved(fn () => $reload());
        static::deleted(fn () => $reload());
    }
}
