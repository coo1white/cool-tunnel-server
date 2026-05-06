<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\CtServerCore;
use Illuminate\Console\Command;

class QuotaEnforce extends Command
{
    protected $signature = 'quota:enforce';

    protected $description = 'Disable accounts past expiry / quota; re-render Caddyfile + reload if any state changed';

    public function handle(CtServerCore $core): int
    {
        $out = $core->enforceQuota();
        $this->info(sprintf(
            'disabled=%d reload=%s',
            (int) ($out['disabled'] ?? 0),
            ($out['reload_triggered'] ?? false) ? 'yes' : 'no',
        ));

        return self::SUCCESS;
    }
}
