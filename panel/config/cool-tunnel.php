<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

// Seed values for the ServerConfig singleton's first-boot row.
// Once row id=1 exists, the panel manages these fields directly
// and these defaults are no longer consulted.
//
// `version` is the panel's own release-of-record. Read by the
// `ct:version` artisan command (Cycle 2 drift-detection probe in
// manifests/panel.upstream.json::verify) and surfaced to the
// component-check matcher as `cool-tunnel-server panel <version>`. Must
// match `manifests/panel.upstream.json::version` — `make
// set-version V=X.Y.Z` updates both atomically. NOT operator-
// editable; not env-driven; bumped only at release cut time.
//
// `panel_domain` is the Cycle 3 / v0.0.55 single source of truth
// for the panel hostname. Mirrored byte-for-byte by
// core/ct-server-core/src/util/domain.rs::panel_domain — the
// CI guard scripts/verify_sot.sh asserts the two implementations
// produce equivalent output for fixture envs. Resolution:
//   1. `PANEL_DOMAIN` env if set + non-empty (after trim)
//   2. else `panel.<DOMAIN>` from env DOMAIN (after trim)
//   3. else empty string (deferred fail-fast — see below)
// All panel-side callers that need the panel hostname must read
// `config('cool-tunnel.panel_domain')` rather than re-deriving.
//
// Why deferred fail-fast instead of throwing at config-load:
// Laravel's bootstrap loads config unconditionally for every
// process — HTTP request, php artisan, phpunit, larastan static
// analysis. Throwing at load-time crashes test/CI contexts where
// DOMAIN/PANEL_DOMAIN may legitimately be empty (phpunit.xml's
// fixture env doesn't set them, larastan's larastan-bootstrap
// boots a fresh Laravel without .env). The Rust side
// (util::domain::panel_domain) keeps its fail-fast because it's
// only ever invoked at runtime by CLI subcommands or renderers
// that NEED the value. PHP returns empty; the caller (e.g.
// ProxyAccount::subscriptionUrl) treats empty as
// "panel hostname not configured" and returns null. The CI guard
// scripts/verify_sot.sh asserts the equivalence: when env is
// fully set, PHP and Rust produce identical strings; when env is
// empty, PHP produces empty + Rust produces non-zero exit, both
// counted as the same "fail" signal.
$resolvePanelDomain = function (): string {
    $explicit = trim((string) env('PANEL_DOMAIN', ''));
    if ($explicit !== '') {
        return $explicit;
    }
    $domain = trim((string) env('DOMAIN', ''));
    if ($domain !== '') {
        return "panel.{$domain}";
    }

    return '';
};

return [
    'domain' => env('DOMAIN', 'proxy.example.com'),
    'panel_domain' => $resolvePanelDomain(),
    'acme_email' => env('ACME_EMAIL', 'admin@example.com'),
    'acme_directory' => env(
        'ACME_DIRECTORY',
        'https://acme-v02.api.letsencrypt.org/directory'
    ),
    'version' => '0.4.17',
    'singbox_direct_domain_strategy' => env('SINGBOX_DIRECT_DOMAIN_STRATEGY', 'prefer_ipv4'),
    'singbox_direct_connect_timeout' => env('SINGBOX_DIRECT_CONNECT_TIMEOUT', '2s'),
    'singbox_direct_fallback_delay' => env('SINGBOX_DIRECT_FALLBACK_DELAY', '100ms'),
];
