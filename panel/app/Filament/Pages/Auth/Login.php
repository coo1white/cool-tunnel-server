<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Pages\Auth;

use Filament\Http\Responses\Auth\Contracts\LoginResponse;
use Filament\Pages\Auth\Login as FilamentLogin;
use Illuminate\Contracts\Support\Htmlable;
use Illuminate\Support\HtmlString;
use Illuminate\Validation\ValidationException;

// H1 (2026-05-05 audit) — Filament 3's stock Login page does not
// throttle authentication attempts. We subclass it solely to call
// `rateLimit()` (provided by Filament's CanRateLimit trait) before
// running the parent's authentication. The named limiter lives in
// App\Providers\AppServiceProvider::configureRateLimiters().
//
// Wired via AdminPanelProvider::panel()->login(self::class).

class Login extends FilamentLogin
{
    public function getHeading(): string | Htmlable
    {
        return 'Log in to Cool Tunnel Server';
    }

    public function getSubheading(): string | Htmlable | null
    {
        return new HtmlString(
            'Use the admin account created during <code>./ct install</code>. '.
            'Locked out? On the VPS run <code>docker compose exec panel php artisan ct:make-admin --force --email=you@example.com</code>.',
        );
    }

    /**
     * @throws ValidationException
     */
    public function authenticate(): ?LoginResponse
    {
        // 5 attempts per minute per (email|ip), plus a wider 20/min
        // per-IP cap configured in AppServiceProvider. On exceed,
        // Filament's trait throws a localised ValidationException
        // that surfaces as the standard "Too many attempts" form
        // error — no info leak about whether the email exists.
        $this->rateLimit(5);

        return parent::authenticate();
    }
}
