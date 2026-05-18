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
 * first re-renders, the second short-circuits inside
 * `SingBoxConfigGeneratorInterface::renderToFile()` on the hash
 * compare.
 *
 * Mirrors the contract of the legacy `App\Jobs\ReloadSingBoxJob`,
 * which now bridges its `handle()` method into a single
 * `$bus->dispatch(new ReloadSingBox(reason: 'legacy-job-bridge'))`
 * call. Phase 3 will retire the Job class entirely and update
 * call sites to dispatch this message directly.
 *
 * Introduced in v0.0.93 as Phase 2 of the Symfony-infusion arc.
 */
final readonly class ReloadSingBox
{
    public function __construct(
        public string $reason = 'unspecified',
    ) {}
}
