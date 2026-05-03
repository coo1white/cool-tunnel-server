<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\CaddyReloader;
use App\Services\CaddyfileGenerator;
use Illuminate\Console\Command;

class CaddyfileRender extends Command
{
    protected $signature   = 'caddyfile:render {--if-changed : Only reload if the file changed} {--reload : Reload caddy after a successful render}';
    protected $description = 'Render the Caddyfile from the DB via ct-server-core (and optionally reload Caddy)';

    public function handle(CaddyfileGenerator $gen, CaddyReloader $reloader): int
    {
        $newHash = $gen->renderToFile();

        if ($newHash === null) {
            $this->info('caddyfile unchanged');
            if (! $this->option('if-changed') && $this->option('reload')) {
                $reloader->reload();
            }
            return self::SUCCESS;
        }

        $this->info("caddyfile rendered hash={$newHash}");
        if ($this->option('reload')) {
            $reloader->reload();
        }
        return self::SUCCESS;
    }
}
