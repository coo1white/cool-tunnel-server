<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Contracts;

/**
 * Contract for the Filament Components page's OK/NG checker.
 *
 * Wraps `CtServerCoreInterface::componentCheck()` with a
 * short-lived (30 s) cache so a fast click-through doesn't
 * hammer the DB / docker CLI. Implementations expose:
 *
 *   - `check()`: returns the row array, with an opt-in
 *     `$useCache` bypass for the "Re-check" button.
 *   - `summarize()`: collapses rows to {ok,ng,total} counts
 *     for the page header.
 *
 * The row array shape is the JSON the Rust core emits — see
 * `manifests/*.upstream.json` for the canonical schema.
 *
 * Real implementation: `App\Services\ComponentChecker`.
 */
interface ComponentCheckerInterface
{
    /**
     * @return array<int, array{name:string, installed_version:?string, pinned_version:string, state:string, message:string}>
     */
    public function check(bool $useCache = true, string $manifestsDir = '/srv/manifests'): array;

    /**
     * @param  array<int, array{state:string}>  $rows
     * @return array{ok:int, ng:int, total:int}
     */
    public function summarize(array $rows): array;
}
