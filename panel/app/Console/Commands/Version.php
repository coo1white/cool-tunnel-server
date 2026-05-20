<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Console\Commands;

use Illuminate\Console\Command;

// Output discipline:
//   - exactly one stdout line, terminated by \n
//   - no ANSI styling (would leak into the matcher's
//     installed_version field — `$this->info()` colours green;
//     `$this->line()` is plain)
//   - no DB call, no I/O beyond config() — keeps the probe
//     under the 15s `verify_via_command` timeout even on a
//     hung-DB host
//   - exit 0 — `expect_zero_exit: true` on the manifest; a
//     non-zero exit (e.g. config file unreadable) flips the
//     matcher to VerifyFailed before the version compare runs

class Version extends Command
{
    protected $signature = 'ct:version';

    protected $description = "Print the panel's release version";

    public function handle(): int
    {
        $version = (string) config('cool-tunnel.version', '');
        if ($version === '') {
            $this->error('config(cool-tunnel.version) is empty — check panel/config/cool-tunnel.php');

            return self::FAILURE;
        }

        $this->line("Cool Tunnel Panel {$version}");

        return self::SUCCESS;
    }
}
