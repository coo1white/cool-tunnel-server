<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Pages\Auth;

use Filament\Http\Responses\Auth\Contracts\LoginResponse;
use Filament\Pages\Auth\Login as FilamentLogin;
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
