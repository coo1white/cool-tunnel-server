<?php

declare(strict_types=1);

use App\Http\Controllers\FakeSiteController;
use App\Http\Controllers\SubscriptionController;
use Illuminate\Support\Facades\Route;

// API: subscription manifest for cross-platform clients. The token
// is HMAC-protected so unauthenticated requests can't enumerate
// accounts.
Route::get('/api/v1/subscription/{token}', [SubscriptionController::class, 'show'])
    ->where('token', '[A-Za-z0-9_-]+')
    ->name('api.subscription');

// Filament's panel provider auto-registers everything under /admin.
// Everything else goes to the FakeSiteController catch-all so an
// unauthenticated probe sees the cover site rather than a Laravel
// welcome page.
Route::get('/',          [FakeSiteController::class, 'show'])->name('fake-site.home');
Route::get('/{any}',     [FakeSiteController::class, 'show'])
    ->where('any', '^(?!admin|livewire|up|api).*$')
    ->name('fake-site.any');
