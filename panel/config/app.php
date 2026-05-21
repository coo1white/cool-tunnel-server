<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Support\Facades\Facade;
use Illuminate\Support\ServiceProvider;

return [
    'name' => env('APP_NAME', 'cool-tunnel-server'),
    'env' => env('APP_ENV', 'production'),
    'debug' => (bool) env('APP_DEBUG', false),
    'url' => env('APP_URL', 'http://localhost'),
    'asset_url' => env('ASSET_URL'),
    'timezone' => env('APP_TIMEZONE', 'UTC'),
    'locale' => 'en',
    'fallback_locale' => 'en',
    'faker_locale' => 'en_US',
    // AES-256-GCM, not CBC: the Rust core's laravel_crypt module
    // (core/ct-server-core/src/laravel_crypt.rs) decodes only the
    // GCM envelope (`tag` field present, 12-byte iv). The legacy
    // CBC envelope (`mac` field present, 16-byte iv) returns
    // InvalidPayload, which makes ct-server-core silently drop the
    // affected ServerConfig field at render time.
    //
    // v0.4.0 — the encrypted-at-rest surface is the ServerConfig
    // `reality_private_key` column (Laravel's `encrypted` cast wraps
    // Crypt::encryptString on write, Crypt::decryptString on read).
    // ProxyAccount.uuid is plain text — the UUID IS the credential and
    // a DB dump containing the encrypted-at-rest form recovers to
    // cleartext under APP_KEY exposure anyway (APP_KEY lives on the
    // same volume), so the wrapper added complexity without real
    // defence-in-depth for that column.
    'cipher' => 'AES-256-GCM',
    'key' => env('APP_KEY'),
    // APP_PREVIOUS_KEYS: comma-separated list of older APP_KEYs that
    // Crypt::decryptString() will try as fallbacks (used during a
    // key-rotation grace period). Trim each segment before
    // array_filter — without trim, a stray space or `\n` in .env
    // produces a malformed key, which silently fails decryption.
    // The user-visible symptom previously: ProxyAccount rows
    // dropping out of the rendered manifest after a key rotation.
    // (M-panel-1 in 2026-05-05 audit.)
    'previous_keys' => array_values(array_filter(array_map(
        'trim',
        explode(',', (string) env('APP_PREVIOUS_KEYS', '')),
    ))),
    'maintenance' => [
        'driver' => 'file',
        'store' => 'database',
    ],
    'providers' => ServiceProvider::defaultProviders()->toArray(),
    'aliases' => Facade::defaultAliases()->toArray(),
];
