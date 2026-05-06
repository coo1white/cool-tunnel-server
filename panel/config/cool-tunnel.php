<?php

declare(strict_types=1);

// Seed values for the ServerConfig singleton's first-boot row.
// Once row id=1 exists, the panel manages these fields directly
// and these defaults are no longer consulted.
return [
    'domain' => env('DOMAIN', 'proxy.example.com'),
    'acme_email' => env('ACME_EMAIL', 'admin@example.com'),
    'acme_directory' => env(
        'ACME_DIRECTORY',
        'https://acme-v02.api.letsencrypt.org/directory'
    ),
];
