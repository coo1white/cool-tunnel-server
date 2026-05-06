<?php

declare(strict_types=1);

// Seed values for the ServerConfig singleton's first-boot row.
// Once row id=1 exists, the panel manages these fields directly
// and these defaults are no longer consulted.
//
// `version` is the panel's own release-of-record. Read by the
// `ct:version` artisan command (Cycle 2 drift-detection probe in
// manifests/panel.upstream.json::verify) and surfaced to the
// component-check matcher as `Cool Tunnel Panel <version>`. Must
// match `manifests/panel.upstream.json::version` — `make
// set-version V=X.Y.Z` updates both atomically. NOT operator-
// editable; not env-driven; bumped only at release cut time.
return [
    'domain' => env('DOMAIN', 'proxy.example.com'),
    'acme_email' => env('ACME_EMAIL', 'admin@example.com'),
    'acme_directory' => env(
        'ACME_DIRECTORY',
        'https://acme-v02.api.letsencrypt.org/directory'
    ),
    'version' => '0.0.39',
];
