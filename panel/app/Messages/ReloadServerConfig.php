<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Messages;

/**
 * Request to re-render Caddyfile + sing-box config from the
 * current `ServerConfig` row. ct-singbox's supervisor picks up
 * the sing-box file change; the host-side operator owns explicit
 * Caddy reloads during updates.
 *
 * Caddyfile render runs FIRST so the operator's "I changed the
 * panel domain" case lands the new TLS cert path before sing-
 * box re-reads it on its next reload (sing-box's render hash
 * feeds in cert mtime — order matters for one-pass
 * reconciliation).
 *
 * Dispatched directly from model events and panel actions after
 * the surrounding DB transaction commits.
 */
final readonly class ReloadServerConfig
{
    public function __construct(
        public string $reason = 'unspecified',
    ) {}
}
