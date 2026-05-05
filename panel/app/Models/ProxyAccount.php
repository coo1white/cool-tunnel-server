<?php

declare(strict_types=1);

namespace App\Models;

use App\Jobs\ReloadSingBoxJob;
use App\Services\RedisRevocationBus;
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
//      hot path operators feel — fired SYNCHRONOUSLY from booted()
//      because the announce is already fire-and-forget at the
//      Redis-pub level.
//
//   2. ASYNCHRONOUS PHP-side render+reload as a backstop, dispatched
//      to the database-backed queue (see App\Jobs\ReloadSingBoxJob).
//      Pre-2026-05-05 this fired synchronously inside saved()/
//      deleted(); a hung ct-server-core stalled the whole Filament
//      request, and a bulk-delete fanned out N synchronous reloads.
//      Both layers dedupe by SHA-256, so racing reloads (e.g. queue
//      worker firing while another save is mid-flight) reduce to a
//      no-op-after-first.
//
// password_cleartext_encrypted holds the cleartext sealed with
// Laravel's Crypt — sing-box's `naive` inbound checks the password
// directly (not as a hash), so we have to keep the cleartext at
// rest. password_hash is preserved for audit/legacy purposes.

class ProxyAccount extends Model
{
    use HasFactory;

    /**
     * Mass-assignable attributes.
     *
     * password_hash and password_cleartext_encrypted are deliberately
     * NOT in this list. Anything that needs to set them must go
     * through {@see setCleartextPassword()}, which writes both
     * consistently. This makes it impossible for a Filament form
     * field, an API endpoint, or a stray array-fill to poison those
     * columns by accident — Eloquent's MassAssignmentException
     * fires immediately.
     */
    protected $fillable = [
        'username', 'label', 'enabled',
        'quota_bytes', 'used_bytes', 'expires_at', 'last_seen_at',
        'metadata',
    ];

    /**
     * Hidden from array / JSON serialisation. The cleartext column
     * MUST stay hidden — leaking it in a panel response would defeat
     * the encrypt-at-rest scheme entirely.
     */
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
        // Hot path: announce on Redis pub/sub synchronously. The
        // daemon picks this up in ~1ms; the announce itself is
        // fire-and-forget against the Redis socket, so it does not
        // stall the Filament request even when N saves fire from a
        // bulk-action.
        //
        // Cold path: dispatch ReloadSingBoxJob to the database queue
        // for the panel-side config render + clash-API reload
        // backstop. Pre-2026-05-05 the cold path ran synchronously
        // and a hung ct-server-core blocked the whole save for up
        // to 60s.
        static::saved(function (self $account): void {
            $bus    = app(RedisRevocationBus::class);
            $status = $account->isActive() ? 'active'
                    : ($account->expires_at && $account->expires_at->isPast() ? 'expired' : 'revoked');
            $bus->setAccountStatus($account->username, $status);
            $bus->announceAccountChanged($account->username, "saved:{$status}");

            ReloadSingBoxJob::dispatch();
        });

        static::deleted(function (self $account): void {
            $bus = app(RedisRevocationBus::class);
            $bus->clearAccountStatus($account->username);
            $bus->announceAccountChanged($account->username, 'deleted');

            ReloadSingBoxJob::dispatch();
        });
    }
}
