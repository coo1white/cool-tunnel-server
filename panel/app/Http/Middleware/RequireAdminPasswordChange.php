<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Models\User;
use Closure;
use Filament\Facades\Filament;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class RequireAdminPasswordChange
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = Filament::auth()->user();
        if (! $user instanceof User || $user->must_change_password !== true) {
            return $next($request);
        }

        if ($request->routeIs('filament.admin.auth.profile', 'filament.admin.auth.logout')) {
            return $next($request);
        }

        return redirect()->to(Filament::getProfileUrl() ?? Filament::getUrl());
    }
}
