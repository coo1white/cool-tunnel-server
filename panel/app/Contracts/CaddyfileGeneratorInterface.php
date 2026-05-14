<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Contracts;

/**
 * Contract for rendering the canonical Caddyfile (panel domain
 * reverse-proxy + ACME) from the current `ServerConfig` row and
 * writing it to disk atomically.
 *
 * Caddy picks up the new file via its admin-API file-watch path;
 * no explicit reload call is needed from PHP — writing the file
 * is sufficient.
 *
 * Implementations MUST honour the same SHA-256 idempotency
 * contract as `SingBoxConfigGeneratorInterface`: identical input
 * MUST return the same hash without rewriting the file.
 *
 * Failures MUST be swallowed to a `critical`-level log and
 * return `null` — never throw.
 *
 * Real implementation: `App\Services\CaddyfileGenerator`.
 */
interface CaddyfileGeneratorInterface
{
    /**
     * Render and atomically write the Caddyfile.
     *
     * @return string|null  Hex-encoded SHA-256 of the rendered
     *                      bytes on success; null on failure.
     */
    public function renderToFile(): ?string;
}
