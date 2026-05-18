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
 *
 * v0.0.10 and earlier: this file was a copy of CaddyfileRender.php
 * and declared `class CaddyfileRender`, which collided with the
 * actual CaddyfileRender.php at Laravel boot ("Cannot declare
 * class App\Console\Commands\CaddyfileRender, because the name is
 * already in use"). Fixed by giving this file the class it should
 * have always had.
 */
class SingBoxRender extends Command
{
    protected $signature = 'singbox:render
                            {--if-changed : Compatibility option; rendering is always hash-idempotent}
                            {--reload     : Compatibility no-op; file-watch handles reloads}';

    protected $description = 'Render the sing-box config from the DB';

    public function handle(SingBoxConfigGenerator $gen): int
    {
        $newHash = $gen->renderToFile();

        if ($newHash === null) {
            $this->info('sing-box config unchanged');

            return self::SUCCESS;
        }

        $this->info("sing-box config rendered hash={$newHash}");

        return self::SUCCESS;
    }
}
