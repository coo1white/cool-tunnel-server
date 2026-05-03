<?php

declare(strict_types=1);

namespace App\Models;

use App\Services\RedisRevocationBus;
use App\Services\SingBoxConfigGenerator;
use App\Services\SingBoxReloader;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Facades\Crypt;

// One row per proxy user.
//
// Anytime an account is created, edited, or deleted we re-render the
// sing-box config.json and ask sing-box to hot-reload via its clash
// API. Two paths fire in sequence:
//
//   1. Redis pub/sub → ct-server-core daemon picks it up within ~1ms,
//      runs through the Coalescer (≤2 reloads per 100ms window
//      regardless of burst size), and reloads. This is the ≤100ms
//      hot path operators feel.
//
//   2. Synchronous PHP-side render+reload as a backstop. Both layers
//      dedupe by SHA-256, so a duplicate reload is a no-op.
//
// password_cleartext_encrypted holds the cleartext sealed with
// Laravel's Crypt — sing-box's `naive` inbound checks the password
// directly (not as a hash), so we have to keep the cleartext at
// rest. password_hash is preserved for audit/legacy purposes.

class ProxyAccount extends Model
{
    use HasFactory;

    protected $fillable = [
        'username', 'password_hash', 'password_cleartext_encrypted',
        'label', 'enabled',
        'quota_bytes', 'used_bytes', 'expires_at', 'last_seen_at',
        'metadata',
    ];

    protected $hidden = [
        'password_hash',
        'password_cleartext_encrypted',
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

    /** Whether the account is currently considered active by sing-box. */
    public function isActive(): bool
    {
        if (! $this->enabled)                                              return false;
        if ($this->expires_at && $this->expires_at->isPast())              return false;
        if ($this->quota_bytes && $this->used_bytes >= $this->quota_bytes) return false;
        return true;
    }

    /**
     * Set the cleartext password. Stores the bcrypt hash and a
     * Laravel-encrypted copy of the cleartext (sing-box needs it).
     */
    public function setCleartextPassword(string $cleartext): void
    {
        $this->password_hash                   = password_hash($cleartext, PASSWORD_BCRYPT, ['cost' => 12]);
        $this->password_cleartext_encrypted    = Crypt::encryptString($cleartext);
    }

    /**
     * Decrypt and return the cleartext password — used by the
     * SingBoxConfigGenerator at render time. Returns null if the
     * row predates the cleartext column or decryption fails.
     */
    public function getCleartextPassword(): ?string
    {
        if (empty($this->password_cleartext_encrypted)) {
            return null;
        }
        try {
            return Crypt::decryptString($this->password_cleartext_encrypted);
        } catch (\Throwable) {
            return null;
        }
    }

    protected static function booted(): void
    {
        static::saved(function (self $account): void {
            $bus    = app(RedisRevocationBus::class);
            $status = $account->isActive() ? 'active'
                    : ($account->expires_at && $account->expires_at->isPast() ? 'expired' : 'revoked');
            $bus->setAccountStatus($account->username, $status);
            $bus->announceAccountChanged($account->username, "saved:{$status}");

            $generator = app(SingBoxConfigGenerator::class);
            $hash      = $generator->renderToFile();
            if ($hash !== null) {
                app(SingBoxReloader::class)->reload();
            }
        });

        static::deleted(function (self $account): void {
            $bus = app(RedisRevocationBus::class);
            $bus->clearAccountStatus($account->username);
            $bus->announceAccountChanged($account->username, 'deleted');

            $generator = app(SingBoxConfigGenerator::class);
            $hash      = $generator->renderToFile();
            if ($hash !== null) {
                app(SingBoxReloader::class)->reload();
            }
        });
    }
}
