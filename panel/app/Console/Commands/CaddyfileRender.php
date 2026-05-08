<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\CaddyfileGenerator;
use Illuminate\Console\Command;

/**
 * `php artisan caddyfile:render` — write Caddy's config from the
 * panel's DB state.
 *
 * Idempotent. CaddyfileGenerator dedupes by SHA-256, so running this
 * in a tight loop is safe and cheap.
 */
class CaddyfileRender extends Command
{
    protected $signature = 'caddyfile:render';

    protected $description = 'Render the Caddyfile from the DB via ct-server-core';

    public function handle(CaddyfileGenerator $gen): int
    {
        $newHash = $gen->renderToFile();
        if ($newHash === null) {
            $this->info('Caddyfile unchanged');
        } else {
            $this->info("Caddyfile rendered hash={$newHash}");
        }

        return self::SUCCESS;
    }
}
