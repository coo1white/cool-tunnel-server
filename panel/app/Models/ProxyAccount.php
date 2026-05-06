<?php

declare(strict_types=1);

namespace App\Models;

use App\Jobs\ReloadSingBoxJob;
use App\Services\RedisRevocationBus;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;

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
            'enabled' => 'boolean',
            'quota_bytes' => 'integer',
            'used_bytes' => 'integer',
            'expires_at' => 'datetime',
            'last_seen_at' => 'datetime',
            'metadata' => 'array',
        ];
    }

    public function trafficLogs(): HasMany
    {
        return $this->hasMany(TrafficLog::class);
    }

    /**
     * Generate a subscription token for this account.
     *
     * Token format: base64url("<account_id>.<hmac_sha256(account_id, APP_KEY)>")
     * Mirrors the verification in SubscriptionController::resolve() in reverse.
     * Returns empty string when APP_KEY is unset.
     */
    public function subscriptionToken(): string
    {
        $key = (string) config('app.key');
        if ($key === '') {
            return '';
        }
        $idStr = (string) $this->getKey();
        $sig = hash_hmac('sha256', $idStr, $key);

        return rtrim(strtr(base64_encode($idStr.'.'.$sig), '+/', '-_'), '=');
    }

    /**
     * Full HTTPS subscription URL for this account.
     * Returns null when APP_KEY is unset or the domain is not yet configured.
     */
    public function subscriptionUrl(): ?string
    {
        $token = $this->subscriptionToken();
        if ($token === '') {
            return null;
        }
        $domain = (string) ServerConfig::current()->getAttribute('domain');
        if ($domain === '') {
            return null;
        }

        return "https://{$domain}/api/v1/subscription/{$token}";
    }

    /** Whether the account is currently considered active by sing-box. */
    public function isActive(): bool
    {
        if (! $this->enabled) {
            return false;
        }
        if ($this->expires_at && $this->expires_at->isPast()) {
            return false;
        }
        if ($this->quota_bytes && $this->used_bytes >= $this->quota_bytes) {
            return false;
        }

        return true;
    }

    /**
     * Set the cleartext password. Stores the bcrypt hash and a
     * Laravel-encrypted copy of the cleartext (sing-box needs it).
     */
    public function setCleartextPassword(string $cleartext): void
    {
        $this->password_hash = password_hash($cleartext, PASSWORD_BCRYPT, ['cost' => 12]);
        $this->password_cleartext_encrypted = Crypt::encryptString($cleartext);
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
        // Both paths defer to DB::afterCommit so the announce + reload
        // dispatch only fire if the surrounding DB transaction
        // actually commits. Pre-v0.0.15 the announce ran inline in the
        // model event, which fires AFTER the row's INSERT/UPDATE but
        // BEFORE the transaction commits — a rollback later in the
        // same transaction would still leave a Redis "revoked" flag
        // and a queued ReloadSingBoxJob for a row that never landed.
        // The daemon would re-render config.json from a DB snapshot
        // missing that row (correct), but `account:status:<user>` in
        // Redis would persist as "revoked" (incorrect ghost state),
        // and the queue worker would dispatch to the clash API for
        // a non-existent change (wasted work).
        //
        // DB::afterCommit semantics:
        //   - inside a transaction: callback queued, fired after the
        //     OUTERMOST transaction commits. If any nested transaction
        //     rolls back, the callback never runs.
        //   - outside a transaction: callback runs immediately. The
        //     pre-v0.0.15 inline behaviour for non-transactional
        //     saves is preserved.
        //
        // We snapshot $username and $status at saved-time so the
        // callback closure doesn't dereference a stale or
        // post-rollback Eloquent instance — the values are frozen
        // at the moment the row's intended state was decided, and
        // the broadcast announces that frozen state when (and only
        // if) the row actually persists.
        //
        // Hot path (Redis pub/sub) is still ~1ms fire-and-forget;
        // cold path (ReloadSingBoxJob) still runs out-of-band on
        // the queue worker. Only the trigger boundary moved.
        static::saved(function (self $account): void {
            $username = $account->username;
            $status = $account->isActive() ? 'active'
                      : ($account->expires_at && $account->expires_at->isPast() ? 'expired' : 'revoked');

            DB::afterCommit(function () use ($username, $status): void {
                $bus = app(RedisRevocationBus::class);
                $bus->setAccountStatus($username, $status);
                $bus->announceAccountChanged($username, "saved:{$status}");

                ReloadSingBoxJob::dispatch();
            });
        });

        static::deleted(function (self $account): void {
            $username = $account->username;

            DB::afterCommit(function () use ($username): void {
                $bus = app(RedisRevocationBus::class);
                $bus->clearAccountStatus($username);
                $bus->announceAccountChanged($username, 'deleted');

                ReloadSingBoxJob::dispatch();
            });
        });
    }
}
