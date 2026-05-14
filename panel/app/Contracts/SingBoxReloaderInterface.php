<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Contracts;

/**
 * Contract for hot-reloading sing-box via its clash API after a
 * config render has landed on disk.
 *
 * Implementations are expected to:
 *   - PUT the rendered config path to sing-box's clash API
 *     `/configs` endpoint, authenticated with the secret derived
 *     from `CT_CLASH_SECRET_SEED`.
 *   - Return `true` when the reload succeeds (status 204), `false`
 *     when sing-box rejects the config or the call fails.
 *   - Log at `warning` or `critical` on failure but never throw.
 *
 * The combination of `renderToFile()` returning a hash and
 * `reload()` returning a bool lets the two-call sequence skip
 * the HTTP roundtrip when nothing changed:
 *
 *     $hash = $generator->renderToFile();
 *     if ($hash !== null) { $reloader->reload(); }
 *
 * Real implementation: `App\Services\SingBoxReloader`.
 */
interface SingBoxReloaderInterface
{
    public function reload(): bool;
}
