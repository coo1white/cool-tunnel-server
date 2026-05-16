<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Contracts;

/**
 * Contract for rendering /data/config/naive.json — the file
 * ct-naive's Bun supervisor watches at runtime. Each write
 * triggers an automatic naive-child respawn (~250 ms debounce),
 * so there is no separate "reload naive" surface — writing the
 * file IS the reload primitive.
 *
 * Lifecycle (v0.3.0+):
 *   - ProxyAccount save → ReloadSingBoxHandler dispatches this
 *     generator (renaming the message + handler is a future
 *     cleanup; the wire shape is unchanged).
 *   - ServerConfig save → ReloadServerConfigHandler dispatches
 *     this generator alongside the Caddyfile render.
 *
 * Implementations MUST honour the same SHA-256 idempotency
 * contract as {@see CaddyfileGeneratorInterface} and
 * {@see SingBoxConfigGeneratorInterface}: identical input MUST
 * return the same hash without rewriting the file.
 *
 * Failures MUST be swallowed to a `critical`-level log and
 * return `null` — never throw, so a transient docker hiccup or
 * cleartext-decryption fault doesn't break the surrounding
 * Filament save.
 *
 * Real implementation: `App\Services\NaiveConfigGenerator`.
 */
interface NaiveConfigGeneratorInterface
{
    /**
     * Render and atomically write /data/config/naive.json.
     *
     * @return string|null Hex-encoded SHA-256 of the rendered
     *                     bytes on success; null on failure.
     */
    public function renderToFile(): ?string;
}
