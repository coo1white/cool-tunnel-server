<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\NaiveConfigGenerator;
use Illuminate\Console\Command;

/**
 * `php artisan naive:render` — write ct-naive's config
 * (`/data/config/naive.json`) from the panel's DB state.
 *
 * Idempotent. NaiveConfigGenerator dedupes by SHA-256, so running
 * this in a tight loop is safe and cheap.
 *
 * v0.3.0+ replacement for `singbox:render` from the panel's
 * boot-time artisan dance. ct-naive's Bun supervisor file-watches
 * /data/config/naive.json and respawns the naive child on change —
 * there is no separate `naive:reload` artisan because writing the
 * file IS the reload primitive.
 */
class NaiveRender extends Command
{
    protected $signature = 'naive:render';

    protected $description = 'Render /data/config/naive.json from the DB via ct-server-core';

    public function handle(NaiveConfigGenerator $gen): int
    {
        $newHash = $gen->renderToFile();
        if ($newHash === null) {
            $this->info('naive.json unchanged');
        } else {
            $this->info("naive.json rendered hash={$newHash}");
        }

        return self::SUCCESS;
    }
}
