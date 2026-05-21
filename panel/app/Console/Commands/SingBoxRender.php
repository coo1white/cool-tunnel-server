<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\SingBoxConfigGenerator;
use Illuminate\Console\Command;

/**
 * `php artisan singbox:render` — write sing-box's config.json from
 * the panel's DB state.
 *
 * Idempotent. SingBoxConfigGenerator dedupes by SHA-256 (with
 * cert-mtime folded in), so running this in a tight loop is safe
 * and cheap. ct-singbox's supervisor watches the rendered file and
 * restarts sing-box when the file changes.
 */
class SingBoxRender extends Command
{
    protected $signature = 'singbox:render
                            {--if-changed : Accepted for scheduler/operator calls; rendering is always hash-idempotent}';

    protected $description = 'Render the sing-box config from the DB';

    public function handle(SingBoxConfigGenerator $gen): int
    {
        $result = $gen->renderToFile();

        if ($result->failed) {
            $this->error('sing-box render failed; see singbox.render.* logs');

            return self::FAILURE;
        }

        if (! $result->changed) {
            $this->info('sing-box config unchanged');

            return self::SUCCESS;
        }

        $this->info("sing-box config rendered hash={$result->hash}");

        return self::SUCCESS;
    }
}
