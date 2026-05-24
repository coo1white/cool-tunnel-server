<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Pages\Auth;

use Filament\Forms\Components\Component;
use Filament\Forms\Components\TextInput;
use Filament\Http\Responses\Auth\Contracts\LoginResponse;
use Filament\Pages\Auth\Login as FilamentLogin;
use Illuminate\Contracts\Support\Htmlable;
use Illuminate\Database\Eloquent\Builder;
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
    public function getHeading(): string|Htmlable
    {
        return 'Log in to Cool Tunnel Server';
    }

    public function getSubheading(): string|Htmlable|null
    {
        return null;
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

    protected function getEmailFormComponent(): Component
    {
        return TextInput::make('email')
            ->label('Admin name or email')
            ->required()
            ->autocomplete('username')
            ->autofocus()
            ->extraInputAttributes(['tabindex' => 1]);
    }

    /**
     * @param  array<string, mixed>  $data
     * @return array<string, mixed>
     */
    protected function getCredentialsFromFormData(array $data): array
    {
        $login = trim((string) ($data['email'] ?? ''));

        return [
            'login' => static function (Builder $query) use ($login): void {
                $query->where('email', $login)
                    ->orWhere('name', $login);
            },
            'password' => $data['password'],
        ];
    }
}
