<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Contracts;

use App\Support\RenderResult;

/**
 * Contract for rendering the canonical sing-box config from the
 * current DB state and writing it to disk atomically.
 *
 * Implementations MUST be idempotent at the SHA-256 layer:
 * `renderToFile()` called twice with unchanged DB state MUST NOT
 * rewrite the file. The hash compare is the dedup key for queued
 * and scheduled renders, so two concurrent renders collapse to a
 * single disk write.
 *
 * Transient process failures MUST be logged at `critical` and
 * returned as RenderResult::failed(). Missing input prerequisites
 * may still throw before a subprocess starts because they are
 * operator-fixable configuration defects.
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
     * @return RenderResult Explicit changed / unchanged / failed
     *                      outcome.
     */
    public function renderToFile(): RenderResult;
}
