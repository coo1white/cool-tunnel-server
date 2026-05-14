<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Contracts;

/**
 * Contract for rendering the canonical sing-box config from the
 * current DB state and writing it to disk atomically.
 *
 * Implementations MUST be idempotent at the SHA-256 layer:
 * `renderToFile()` called twice with unchanged DB state MUST
 * return the same hash AND MUST NOT rewrite the file. The hash
 * compare is the dedup key for the v0.0.84 dual-path defense
 * (Redis fast-path + queued backstop) so two concurrent renders
 * collapse to a single disk write.
 *
 * Failures MUST be swallowed to a `critical`-level log and
 * return `null` — never throw out of `renderToFile()`. Callers
 * (model observers, message handlers, scheduled commands) rely
 * on null-on-failure to decide whether to skip a downstream
 * reload.
 *
 * Real implementation: `App\Services\SingBoxConfigGenerator`.
 *
 * Introduced in v0.0.92 as Phase 1 of the Symfony-infusion arc.
 */
interface SingBoxConfigGeneratorInterface
{
    /**
     * Render and atomically write the config.
     *
     * @return string|null Hex-encoded SHA-256 of the rendered
     *                     bytes on success; null on failure.
     */
    public function renderToFile(): ?string;
}
