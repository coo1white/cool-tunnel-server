<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Models;

use Filament\Models\Contracts\FilamentUser;
use Filament\Panel;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;

// Filament admin. NOT a proxy account — see App\Models\ProxyAccount
// for the customer-side credential.

class User extends Authenticatable implements FilamentUser
{
    use HasFactory, Notifiable;

    public const ROLE_ADMIN = 'admin';

    public const ROLE_VIEWER = 'viewer';

    public const ROLES = [self::ROLE_ADMIN, self::ROLE_VIEWER];

    /**
     * Mass-assignable attributes.
     *
     * `password`, `role`, `is_active`, and `must_change_password`
     * are deliberately NOT in this list. A privilege-bearing field
     * that lands in $fillable means a stray
     * `User::create($request->all())` (or a future profile-update
     * endpoint) can promote a viewer to admin or silently rotate a
     * password. Set `password` via the framework's
     * `setPasswordAttribute` (the 'hashed' cast handles the hash);
     * set `role` / `is_active` / password-change flags from
     * console/seeder code only.
     * (H3-ish hardening from 2026-05-05 audit; H2 below.)
     */
    protected $fillable = ['name', 'email'];

    protected $hidden = ['password', 'remember_token'];

    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'is_active' => 'boolean',
            'must_change_password' => 'boolean',
        ];
    }

    public function canAccessPanel(Panel $panel): bool
    {
        // H2 (2026-05-05 audit) — pre-fix this returned `true`
        // unconditionally, making any row in `users` a full-power
        // admin. Now gates on three independent signals:
        //
        //   1. The Filament panel id matches `admin`. Future
        //      multi-panel deployments (operator panel vs. read-only
        //      reporting panel) can grant access selectively.
        //   2. `is_active` — disable an admin without deleting the
        //      row (preserves audit trail / foreign keys).
        //   3. `role` is a known elevated value. Today only
        //      `ROLE_ADMIN` reaches the panel; `ROLE_VIEWER` is
        //      reserved for a future read-only reporting panel that
        //      will live behind a different panel id.
        //
        // Email verification is NOT enforced here because Cool Tunnel
        // ships no SMTP integration in v0.0.1 — `email_verified_at`
        // is set at seed time. Add that gate when SMTP lands.
        if ($panel->getId() !== 'admin') {
            return false;
        }
        if ($this->is_active !== true) {
            return false;
        }

        return $this->role === self::ROLE_ADMIN;
    }

    /**
     * Whether this user is permitted to perform destructive actions
     * (create / update / delete) on ProxyAccount, ServerConfig, etc.
     *
     * A future viewer-tier panel should call this before allowing
     * any write. The Filament Resources currently inherit a
     * "logged-in admin = full access" model — when a Policy layer
     * lands, it should defer to this method so the rule lives in
     * one place.
     */
    public function canManage(): bool
    {
        return $this->is_active === true && $this->role === self::ROLE_ADMIN;
    }
}
