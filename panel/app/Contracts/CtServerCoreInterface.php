<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Contracts;

/**
 * Contract for the PHP-side wrapper around the embedded Rust
 * `ct-server-core` binary. All shell-outs to the binary flow
 * through this contract so the call surface can be mocked
 * cleanly in tests (`CtServerCoreFake` implements this
 * interface to return canned JSON without invoking the real
 * subprocess).
 *
 * `run()` is the low-level dispatcher; typed helpers are thin
 * wrappers that call it with specific argv. Implementations MAY
 * override either layer.
 *
 * Every method returns a decoded JSON array. Subprocess
 * failures (non-zero exit, timeout, JSON parse error) throw. The
 * CLI surface is the place where the caller decides whether the
 * error is recoverable because it has the surrounding operation
 * context.
 *
 * Real implementation: `App\Services\CtServerCore`.
 */
interface CtServerCoreInterface
{
    /**
     * Run an arbitrary `ct-server-core` subcommand.
     *
     * @param  array<int,string>  $args
     * @return array<mixed>
     */
    public function run(array $args, int $timeoutSec = 30): array;

    /** @return array<mixed> */
    public function renderCaddyfile(): array;
}
