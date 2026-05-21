<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Messages;

/**
 * Request to re-render sing-box's config from current DB state.
 * ct-singbox's supervisor picks up changed files and restarts
 * sing-box.
 *
 * Representation-free: the handler always reads current DB
 * state. Two messages back-to-back coalesce naturally — the
 * first re-renders, the second returns RenderResult::unchanged()
 * from `SingBoxConfigGeneratorInterface::renderToFile()` after the
 * hash compare.
 *
 * Dispatched directly from model events and panel actions after
 * the surrounding DB transaction commits.
 */
final readonly class ReloadSingBox
{
    public function __construct(
        public string $reason = 'unspecified',
    ) {}
}
