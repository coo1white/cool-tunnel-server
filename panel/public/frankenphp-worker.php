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

require $octaneWorker;
