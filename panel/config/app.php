<?php

declare(strict_types=1);

return [
    'name'     => env('APP_NAME', 'Cool Tunnel Server'),
    'env'      => env('APP_ENV', 'production'),
    'debug'    => (bool) env('APP_DEBUG', false),
    'url'      => env('APP_URL', 'http://localhost'),
    'timezone' => env('APP_TIMEZONE', 'UTC'),
    'locale'   => 'en',
    'fallback_locale' => 'en',
    'faker_locale'    => 'en_US',
    // AES-256-GCM, not CBC: the Rust core's laravel_crypt module
    // (core/ct-server-core/src/laravel_crypt.rs) decodes only the
    // GCM envelope (`tag` field present, 12-byte iv). The legacy
    // CBC envelope (`mac` field present, 16-byte iv) returns
    // InvalidPayload, which makes ct-server-core silently drop the
    // account from the rendered users list (the warning surfaces
    // as a `traffic:rollup` log line but no user-visible error).
    // Pinning GCM here means setCleartextPassword() writes the
    // shape Rust expects; save the affected accounts once after
    // this change to re-encrypt existing rows.
    'cipher'   => 'AES-256-GCM',
    'key'      => env('APP_KEY'),
    'previous_keys' => [
        ...array_filter(explode(',', (string) env('APP_PREVIOUS_KEYS', ''))),
    ],
    'maintenance' => [
        'driver' => 'file',
        'store'  => 'database',
    ],
];
