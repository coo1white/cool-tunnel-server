<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Models;

use App\Messages\ReloadSingBox;
use App\Support\SingBoxProtocolCatalog;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Symfony\Component\Messenger\MessageBusInterface;
use Throwable;

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
// Anytime an account is created, edited, or deleted we enqueue a
// sing-box config render after the surrounding DB transaction commits.
// ct-singbox's supervisor watches /data/config/singbox.json and
// restarts sing-box when the file changes. The renderer dedupes by
// SHA-256, so racing render jobs reduce to a no-op after the first
// write.

/**
 * @property int $id
 * @property string $username
 * @property string $uuid
 * @property string|null $previous_uuid
 * @property Carbon|null $previous_uuid_valid_until
 * @property string|null $subscription_secret
 * @property string|null $label
 * @property bool $enabled
 * @property int $client_default_local_port
 * @property array<int,string>|null $enabled_protocols
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
        'client_default_local_port',
        'enabled_protocols',
        'expires_at', 'last_seen_at',
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
        'previous_uuid',
        'subscription_secret',
    ];

    protected function casts(): array
    {
        return [
            'enabled' => 'boolean',
            'client_default_local_port' => 'integer',
            'enabled_protocols' => 'array',
            'previous_uuid_valid_until' => 'datetime',
            'expires_at' => 'datetime',
            'last_seen_at' => 'datetime',
            'metadata' => 'array',
        ];
    }

    /**
     * Generate a subscription token for this account.
     *
     * Token format: base64url("<account_id>.<hmac_sha256(account_id[.subscription_secret], APP_KEY)>")
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
        $secret = (string) ($this->subscription_secret ?? '');
        $signed = $secret === '' ? $idStr : "{$idStr}.{$secret}";
        $sig = hash_hmac('sha256', $signed, $key);

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

        return true;
    }

    /**
     * Limit queries to accounts that can currently authenticate.
     *
     * @param  Builder<self>  $query
     * @return Builder<self>
     */
    public function scopeActive(Builder $query): Builder
    {
        return $query
            ->where('enabled', true)
            ->where(function (Builder $query): void {
                $query
                    ->whereNull('expires_at')
                    ->orWhere('expires_at', '>', now());
            });
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
        $oldUuid = (string) ($this->uuid ?? '');
        $uuid = (string) Str::uuid();
        if ($oldUuid !== '' && $oldUuid !== $uuid) {
            $this->previous_uuid = $oldUuid;
            $this->previous_uuid_valid_until = now()->addMinutes(10);
        }
        $this->uuid = $uuid;
        $this->rotateSubscriptionSecret();

        return $uuid;
    }

    public function hasPreviousUuidGrace(): bool
    {
        $previousUuid = (string) ($this->previous_uuid ?? '');
        if ($previousUuid === '') {
            return false;
        }

        return $this->previous_uuid_valid_until !== null
            && $this->previous_uuid_valid_until->isFuture();
    }

    public function rotateSubscriptionSecret(): string
    {
        $secret = hash('sha256', (string) Str::uuid().random_bytes(32));
        $this->subscription_secret = $secret;

        return $secret;
    }

    /** @return list<string> */
    public function enabledProtocolKeys(): array
    {
        return SingBoxProtocolCatalog::normalizeSelected(
            $this->enabled_protocols,
            defaultWhenEmpty: false,
        );
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
            if ((string) ($account->subscription_secret ?? '') === '') {
                $account->rotateSubscriptionSecret();
            }
        });

        static::saving(function (self $account): void {
            $defaultWhenEmpty = ! $account->exists
                && SingBoxProtocolCatalog::invalidKeys($account->enabled_protocols) === [];

            $account->enabled_protocols = SingBoxProtocolCatalog::normalizeSelected(
                $account->enabled_protocols,
                defaultWhenEmpty: $defaultWhenEmpty,
            );
        });

        // The reload dispatch defers to DB::afterCommit so it only
        // fires if the surrounding DB transaction actually commits.
        // Pre-v0.0.15 the reload ran inline in the model event, which
        // fires AFTER the row's INSERT/UPDATE but BEFORE the
        // transaction commits — a rollback later in the same
        // transaction would still leave a reload message for a row
        // that never landed.
        //
        // We snapshot $status at saved-time so the callback closure
        // doesn't dereference a stale or post-rollback Eloquent
        // instance — the value is frozen at the moment the row's
        // intended state was decided.
        static::saved(function (self $account): void {
            $status = $account->isActive() ? 'active'
                      : ($account->expires_at && $account->expires_at->isPast() ? 'expired' : 'revoked');

            DB::afterCommit(function () use ($status): void {
                try {
                    app(MessageBusInterface::class)->dispatch(
                        new ReloadSingBox(reason: "proxy_account.saved:{$status}"),
                    );
                } catch (Throwable $e) {
                    Log::warning('proxy_account.reload.dispatch_failed', [
                        'reason' => "proxy_account.saved:{$status}",
                        'err' => $e->getMessage(),
                        'type' => $e::class,
                        'note' => 'ProxyAccount row committed, but slow-path sing-box render was not queued. '
                            .'The scheduled render reconciles every five minutes.',
                    ]);
                }
            });
        });

        static::deleted(function (self $account): void {
            DB::afterCommit(function (): void {
                try {
                    app(MessageBusInterface::class)->dispatch(
                        new ReloadSingBox(reason: 'proxy_account.deleted'),
                    );
                } catch (Throwable $e) {
                    Log::warning('proxy_account.reload.dispatch_failed', [
                        'reason' => 'proxy_account.deleted',
                        'err' => $e->getMessage(),
                        'type' => $e::class,
                        'note' => 'ProxyAccount row committed, but slow-path sing-box render was not queued. '
                            .'The scheduled render reconciles every five minutes.',
                    ]);
                }
            });
        });
    }
}
