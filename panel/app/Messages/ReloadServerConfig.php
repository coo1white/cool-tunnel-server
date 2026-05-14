<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Messages;

/**
 * Request to re-render Caddyfile + sing-box config from the
 * current `ServerConfig` row and hot-reload sing-box if its
 * config changed. Caddy picks up the new file via its admin-API
 * file-watch path; no explicit reload call is needed.
 *
 * Caddyfile render runs FIRST so the operator's "I changed the
 * panel domain" case lands the new TLS cert path before sing-
 * box re-reads it on its next reload (sing-box's render hash
 * feeds in cert mtime — order matters for one-pass
 * reconciliation).
 *
 * Mirrors the contract of the legacy
 * `App\Jobs\ReloadServerConfigJob`, which now bridges its
 * `handle()` method into a single
 * `$bus->dispatch(new ReloadServerConfig(reason: 'legacy-job-bridge'))`
 * call. Phase 3 will retire the Job class entirely.
 *
 * Introduced in v0.0.93 as Phase 2 of the Symfony-infusion arc.
 */
final readonly class ReloadServerConfig
{
    public function __construct(
        public string $reason = 'unspecified',
    ) {}
}
