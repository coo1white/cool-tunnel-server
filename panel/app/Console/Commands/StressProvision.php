<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\ProxyAccount;
use App\Services\PasswordGenerator;
use Illuminate\Console\Command;

/**
 * `php artisan stress:provision --username=X` — idempotently
 * create or refresh a proxy account for the release-gate stress
 * test harness (see scripts/stress/ + docs/release-stress-test.md).
 *
 * Behaviour:
 *   - Find or create a ProxyAccount with the given username.
 *   - Generate a fresh cleartext password via PasswordGenerator.
 *   - Save it (bcrypt hash for sing-box's basic_auth check;
 *     cleartext encrypted at rest in metadata for the
 *     SubscriptionController flow).
 *   - Print one-line JSON: {"id": N, "password": "..."}.
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

    protected $description = 'Idempotently provision a proxy account for stress tests; emits {"id", "password"} JSON';

    public function handle(PasswordGenerator $pwgen): int
    {
        $username = (string) $this->option('username');
        if (! preg_match('/^[A-Za-z0-9._-]{1,64}$/', $username)) {
            $this->error('username must be ASCII alnum + . _ - (1-64 chars)');
            return self::FAILURE;
        }

        $cleartext = $pwgen::make()['cleartext'];

        // Reuse the existing model accessor that handles bcrypt
        // hashing + Laravel-Crypt encryption of the cleartext for
        // the panel side (SubscriptionController reads it back).
        $account = ProxyAccount::firstOrNew(['username' => $username]);
        $account->label = 'stress-runner (auto-provisioned)';
        $account->enabled = true;
        $account->setCleartextPassword($cleartext);
        $account->save();

        // Emit JSON on the LAST line so the stress harness can
        // grab it via `... | tail -1 | jq`. Anything else logged
        // before this is fine — Symfony/Laravel doesn't
        // typically write to stdout from console commands but
        // some events do.
        $this->line(json_encode([
            'id'       => $account->id,
            'password' => $cleartext,
        ], JSON_UNESCAPED_SLASHES));

        return self::SUCCESS;
    }
}
