<?php

// Set a default for the application base path and public path if they are missing...
$_SERVER['APP_BASE_PATH'] = $_ENV['APP_BASE_PATH'] ?? $_SERVER['APP_BASE_PATH'] ?? __DIR__.'/..';
$_SERVER['APP_PUBLIC_PATH'] = $_ENV['APP_PUBLIC_PATH'] ?? $_SERVER['APP_PUBLIC_PATH'] ?? __DIR__;

// Defensive: if vendor/laravel/octane/ is missing (e.g., composer
// update without octane, or an in-flight composer install), fail
// LOUDLY with a clear diagnostic instead of letting `require` emit
// a Fatal error: failed opening required ... that supervisord
// retries 10 times before going FATAL with no useful signal.
$octaneWorker = __DIR__.'/../vendor/laravel/octane/bin/frankenphp-worker.php';
if (! file_exists($octaneWorker)) {
    fwrite(STDERR, "[frankenphp-worker] laravel/octane not installed at {$octaneWorker}.\n");
    fwrite(STDERR, "[frankenphp-worker] Run: composer install --no-dev --optimize-autoloader --no-scripts\n");
    fwrite(STDERR, "[frankenphp-worker] Then: docker compose restart panel\n");
    exit(1);
}

// v0.0.81 robustness-review fix (item 4): refuse to boot with an
// empty APP_KEY. Without it every encrypted-at-rest column (v0.4.0:
// ServerConfig.reality_private_key; the renderer needs cleartext to
// pass into `singbox-core render-server`) fails to decrypt, and every
// subscription HMAC fails to sign; the framework's exception handler
// then catches the throws per request and degrades each subscription
// URL to 200-with-cover-site bytes. Real users see "subscription URL
// stopped working" while operators see no panel error and assume an
// upstream issue.
//
// Fail HERE, at boot, so the operator gets a clear startup signal
// (supervisord prints stderr; `docker compose logs panel` shows it
// immediately) instead of a quiet wave of degraded URLs hours later.
$appKey = $_ENV['APP_KEY'] ?? getenv('APP_KEY');
if ($appKey === false || $appKey === '') {
    fwrite(STDERR, "[frankenphp-worker] APP_KEY is empty or unset.\n");
    fwrite(STDERR, "[frankenphp-worker] Generate one and write it into the repo-root .env, then docker compose restart panel:\n");
    fwrite(STDERR, "[frankenphp-worker]   docker compose run --rm -T panel php artisan key:generate --show\n");
    fwrite(STDERR, "[frankenphp-worker]   # Paste the printed value into .env as APP_KEY=base64:...\n");
    fwrite(STDERR, "[frankenphp-worker] Refusing to boot — every subscription URL would silently degrade to cover-site bytes.\n");
    exit(1);
}

require $octaneWorker;
