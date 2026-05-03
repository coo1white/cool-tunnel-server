<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\SingBoxConfigGenerator;
use App\Services\SingBoxReloader;
use Illuminate\Console\Command;

/**
 * `php artisan singbox:render` — write sing-box's config.json from
 * the panel's DB state, optionally hot-reload via the clash API.
 *
 * Idempotent. SingBoxConfigGenerator dedupes by SHA-256 (with
 * cert-mtime folded in), so running this in a tight loop is safe
 * and cheap. The scheduled task at every minute calls this with
 * --if-changed --reload, so a cert renewal flips the hash and
 * triggers exactly one reload.
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
                            {--if-changed : Only reload if the rendered file actually changed}
                            {--reload     : Reload sing-box via clash API after a successful render}';

    protected $description = 'Render the sing-box config from the DB via ct-server-core (and optionally hot-reload sing-box)';

    public function handle(SingBoxConfigGenerator $gen, SingBoxReloader $reloader): int
    {
        $newHash = $gen->renderToFile();

        if ($newHash === null) {
            $this->info('sing-box config unchanged');
            if (! $this->option('if-changed') && $this->option('reload')) {
                $reloader->reload();
            }
            return self::SUCCESS;
        }

        $this->info("sing-box config rendered hash={$newHash}");
        if ($this->option('reload')) {
            $reloader->reload();
        }
        return self::SUCCESS;
    }
}
