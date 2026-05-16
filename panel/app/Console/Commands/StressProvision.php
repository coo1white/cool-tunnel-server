<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\ProxyAccount;
use Illuminate\Console\Command;

/**
 * `php artisan stress:provision --username=X` — idempotently
 * create or refresh a proxy account for the release-gate stress
 * test harness (see scripts/stress/ + docs/release-stress-test.md).
 *
 * v0.4.0 behaviour:
 *   - Find or create a ProxyAccount with the given username.
 *   - Generate a fresh VLESS UUID via ProxyAccount::regenerateUuid().
 *   - Save it. The booted() hooks fire as for any other model save —
 *     Redis announces + Messenger backstop dispatch.
 *   - Print one-line JSON: {"id": N, "uuid": "..."}.
 *
 * Why a dedicated command vs. just curling Filament: the stress
 * tests run against a live deploy with no logged-in operator;
 * automating the panel form would require headless-browser
 * scaffolding. The artisan command is direct, idempotent, and
 * doesn't depend on the panel UI being reachable from the
 * stress runner's network.
 */
class StressProvision extends Command
{
    protected $signature = 'stress:provision
                            {--username=stress-runner : account to provision}';

    protected $description = 'Idempotently provision a proxy account for stress tests; emits {"id", "uuid"} JSON';

    public function handle(): int
    {
        $username = (string) $this->option('username');
        if (! preg_match('/^[A-Za-z0-9._-]{1,64}$/', $username)) {
            $this->error('username must be ASCII alnum + . _ - (1-64 chars)');

            return self::FAILURE;
        }

        $account = ProxyAccount::firstOrNew(['username' => $username]);
        $account->label = 'stress-runner (auto-provisioned)';
        $account->enabled = true;
        $uuid = $account->regenerateUuid();
        $account->save();

        // Emit JSON on the LAST line so the stress harness can
        // grab it via `... | tail -1 | jq`. Anything else logged
        // before this is fine — Symfony/Laravel doesn't
        // typically write to stdout from console commands but
        // some events do.
        $this->line(json_encode([
            'id' => $account->id,
            'uuid' => $uuid,
        ], JSON_UNESCAPED_SLASHES));

        return self::SUCCESS;
    }
}
