<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Console\Commands;

use Illuminate\Console\Command;

// Cycle 2 panel drift-detection probe (v0.0.39). Emits exactly one
// line to stdout in the shape `Cool Tunnel Panel <version>`, where
// <version> is read from config('cool-tunnel.version'). The
// component-check matcher in core/ct-server-core/src/components.rs
// asserts `installed.contains(&m.version)` against the pinned
// version in manifests/panel.upstream.json — when the two strings
// drift apart (operator forgot to bump one side, panel image
// pre-dates the manifest, hand-deployed panel with a different
// `cool-tunnel.php`), the matcher flips the row to
// VersionMismatch in the panel Components page.
//
// Pre-v0.0.39 this probe was `php artisan --version` with stdout
// redirected to /dev/null and `expect_no_version_line: true` on
// the manifest — opted-out of drift detection on purpose because
// the Laravel framework's banner ("Laravel Framework 11.x") had
// no relationship to the panel's own version. Cycle 2 replaces
// the framework banner with a panel-owned identity string so the
// matcher's existing soft-version-match has something useful to
// compare against.
//
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

    protected $description = "Print the panel's release version (used by the component-check probe)";

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
