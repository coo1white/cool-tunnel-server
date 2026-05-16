<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Models;

use App\Messages\ReloadSingBox;
use App\Services\RedisRevocationBus;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\Messenger\MessageBusInterface;

// One row per proxy user.
//
// v0.4.0 — sing-box VLESS+Reality replaces NaiveProxy / HTTPS-CONNECT.
// Each account authenticates by per-user UUID (the VLESS user_id field
// inside sing-box's `vless` inbound users[] array), not by basic-auth
// username/password.
//
// The UUID IS the credential, like an API key. We store it in plain
// text on the same disk-protection posture as the rest of the DB; the
// v0.3.x encrypt-at-rest dance for password_cleartext_encrypted
// recovered to cleartext under APP_KEY exposure anyway (APP_KEY and
// the DB live on the same volume), so the wrapper added complexity
// without real defence-in-depth.
//
// Anytime an account is created, edited, or deleted we re-render
// sing-box's config.json and ask sing-box to hot-reload. Two paths
// fire in sequence:
//
//   1. Redis pub/sub → ct-server-core daemon picks it up within ~1ms,
//      runs through the Coalescer (≤2 reloads per 100ms window
//      regardless of burst size), and reloads. This is the ≤100ms
//      hot path operators feel — fired SYNCHRONOUSLY from booted()
//      because the announce is already fire-and-forget at the
//      Redis-pub level.
//
//   2. ASYNCHRONOUS PHP-side render+reload as a backstop, dispatched
//      to Symfony Messenger's Redis Streams transport (see
//      App\Messages\ReloadSingBox + App\MessageHandlers\
//      ReloadSingBoxHandler). [program:messenger] picks it up,
//      renders, reloads. Both layers dedupe by SHA-256, so racing
//      reloads (e.g. worker firing while another save is mid-flight)
//      reduce to a no-op-after-first.

/**
 * @property int $id
 * @property string $username
 * @property string $uuid
 * @property string|null $label
 * @property bool $enabled
 * @property int|null $quota_bytes
 * @property int $used_bytes
 * @property Carbon|null $expires_at
 * @property Carbon|null $last_seen_at
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 */
class ProxyAccount extends Model
{
    use HasFactory;

    /**
     * Mass-assignable attributes.
     *
     * `uuid` is deliberately NOT in this list. The VLESS credential
     * MUST be created or rotated through {@see regenerateUuid()}, which
     * generates a fresh v4 UUID and writes it consistently. This makes
     * it impossible for a Filament form field, an API endpoint, or a
     * stray array-fill to plant an attacker-controlled UUID into the
     * column by accident — Eloquent's MassAssignmentException fires
     * immediately.
     */
    protected $fillable = [
        'username', 'label', 'enabled',
        'quota_bytes', 'used_bytes', 'expires_at', 'last_seen_at',
        'metadata',
    ];

    /**
     * Hidden from array / JSON serialisation. The `uuid` column MUST
     * stay hidden — leaking it in a generic panel response (e.g. an
     * accidental ->toArray() in a Livewire view) would defeat the
     * credential-secrecy posture entirely. The SubscriptionController
     * reads it explicitly via $account->uuid for its signed manifest;
     * no other surface should serialise it.
     */
    protected $hidden = [
        'uuid',
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
     * Returns null when APP_KEY is unset.
     *
     * Hostname comes from `config('cool-tunnel.panel_domain')`, the
     * Cycle 3 / v0.0.55 single source of truth (mirrored byte-for-byte
     * by core/ct-server-core/src/util/domain.rs::panel_domain). The
     * resolution: PANEL_DOMAIN env > panel.<DOMAIN> env > fail-fast.
     */
    public function subscriptionUrl(): ?string
    {
        $token = $this->subscriptionToken();
        if ($token === '') {
            return null;
        }
        $panelDomain = (string) config('cool-tunnel.panel_domain');
        if ($panelDomain === '') {
            // SoT helper returned empty (both PANEL_DOMAIN and
            // DOMAIN unset in .env). Surface as null — the panel
            // UI's "Subscription URL" action shows "Cannot generate
            // URL" rather than constructing a malformed
            // `https:///api/v1/...` link.
            return null;
        }

        return "https://{$panelDomain}/api/v1/subscription/{$token}";
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
     * Generate a fresh v4 UUID and assign it to this account. Returns
     * the new UUID string for one-shot display in the Filament
     * regenerate notification.
     *
     * Caller is responsible for ->save(). The booted() handlers
     * downstream will re-render singbox.json + announce the change
     * exactly as for any other save.
     */
    public function regenerateUuid(): string
    {
        $uuid = (string) Str::uuid();
        $this->uuid = $uuid;

        return $uuid;
    }

    protected static function booted(): void
    {
        // Auto-seed the UUID at the creating event so callers that
        // forget to call regenerateUuid() before ->save() still get a
        // valid credential. The DB column is char(36) UNIQUE; landing
        // a row with uuid=NULL would either violate the unique-on-
        // multi-NULL invariant in a multi-tenant deploy, or be
        // silently inaccessible (sing-box's vless inbound rejects
        // empty user_id at handshake time).
        static::creating(function (self $account): void {
            $current = (string) ($account->uuid ?? '');
            if ($current === '') {
                $account->regenerateUuid();
            }
        });

        // Both paths defer to DB::afterCommit so the announce + reload
        // dispatch only fire if the surrounding DB transaction
        // actually commits. Pre-v0.0.15 the announce ran inline in the
        // model event, which fires AFTER the row's INSERT/UPDATE but
        // BEFORE the transaction commits — a rollback later in the
        // same transaction would still leave a Redis "revoked" flag
        // and a queued ReloadSingBoxJob for a row that never landed.
        //
        // We snapshot $username and $status at saved-time so the
        // callback closure doesn't dereference a stale or
        // post-rollback Eloquent instance — the values are frozen at
        // the moment the row's intended state was decided, and the
        // broadcast announces that frozen state when (and only if)
        // the row actually persists.
        static::saved(function (self $account): void {
            $username = $account->username;
            $status = $account->isActive() ? 'active'
                      : ($account->expires_at && $account->expires_at->isPast() ? 'expired' : 'revoked');

            DB::afterCommit(function () use ($username, $status): void {
                $bus = app(RedisRevocationBus::class);
                $bus->setAccountStatus($username, $status);
                $bus->announceAccountChanged($username, "saved:{$status}");

                app(MessageBusInterface::class)->dispatch(
                    new ReloadSingBox(reason: "proxy_account.saved:{$status}"),
                );
            });
        });

        static::deleted(function (self $account): void {
            $username = $account->username;

            DB::afterCommit(function () use ($username): void {
                $bus = app(RedisRevocationBus::class);
                $bus->clearAccountStatus($username);
                $bus->announceAccountChanged($username, 'deleted');

                app(MessageBusInterface::class)->dispatch(
                    new ReloadSingBox(reason: 'proxy_account.deleted'),
                );
            });
        });
    }
}
