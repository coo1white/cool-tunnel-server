<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Providers\Filament;

use App\Filament\Pages\Auth\EditProfile;
use App\Filament\Pages\Auth\Login;
use App\Http\Middleware\RequireAdminPasswordChange;
use App\Http\Middleware\SecurityHeaders;
use Filament\Http\Middleware\Authenticate;
use Filament\Http\Middleware\AuthenticateSession;
use Filament\Http\Middleware\DisableBladeIconComponents;
use Filament\Http\Middleware\DispatchServingFilamentEvent;
use Filament\Navigation\NavigationGroup;
use Filament\Pages;
use Filament\Panel;
use Filament\PanelProvider;
use Filament\Support\Colors\Color;
use Filament\Widgets;
use Illuminate\Cookie\Middleware\AddQueuedCookiesToResponse;
use Illuminate\Cookie\Middleware\EncryptCookies;
use Illuminate\Foundation\Http\Middleware\VerifyCsrfToken;
use Illuminate\Routing\Middleware\SubstituteBindings;
use Illuminate\Session\Middleware\StartSession;
use Illuminate\View\Middleware\ShareErrorsFromSession;

class AdminPanelProvider extends PanelProvider
{
    public function panel(Panel $panel): Panel
    {
        return $panel
            ->default()
            ->id('admin')
            ->path('admin')
            // Custom Login subclass adds a per-(email|ip) rate limit
            // before delegating to Filament's stock authenticate().
            // (H1 in 2026-05-05 audit.)
            ->login(Login::class)
            ->profile(EditProfile::class)
            ->darkMode()
            ->brandName('cool-tunnel-server')
            ->colors([
                'primary' => Color::Indigo,
            ])
            ->favicon(asset('favicon.svg'))
            ->maxContentWidth('full')
            ->sidebarCollapsibleOnDesktop()
            ->navigationGroups([
                NavigationGroup::make('Users')->icon('heroicon-o-users'),
                NavigationGroup::make('System')->icon('heroicon-o-server-stack'),
            ])
            ->discoverResources(in: app_path('Filament/Resources'),
                for: 'App\\Filament\\Resources')
            ->discoverPages(in: app_path('Filament/Pages'),
                for: 'App\\Filament\\Pages')
            ->pages([
                Pages\Dashboard::class,
            ])
            ->discoverWidgets(in: app_path('Filament/Widgets'),
                for: 'App\\Filament\\Widgets')
            ->widgets([
                Widgets\AccountWidget::class,
            ])
            ->middleware([
                EncryptCookies::class,
                AddQueuedCookiesToResponse::class,
                StartSession::class,
                AuthenticateSession::class,
                ShareErrorsFromSession::class,
                VerifyCsrfToken::class,
                SubstituteBindings::class,
                DisableBladeIconComponents::class,
                DispatchServingFilamentEvent::class,
                // Browser-side hardening on every /admin response —
                // X-Frame-Options DENY, nosniff, Referrer-Policy,
                // Permissions-Policy, no-store Cache-Control, HSTS.
                // Filament 3 does not emit any of these by default;
                // see App\Http\Middleware\SecurityHeaders. (v0.0.18.)
                SecurityHeaders::class,
            ])
            ->authMiddleware([
                Authenticate::class,
                RequireAdminPasswordChange::class,
            ]);
    }
}
