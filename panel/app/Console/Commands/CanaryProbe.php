<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\CtServerCore;
use Illuminate\Console\Command;

class CanaryProbe extends Command
{
    protected $signature = 'canary:probe';

    protected $description = 'Run one self-probe canary cycle (DoH-resolve apex + TCP-connect to haproxy:443); appends to ServerConfig.self_probe_history';

    public function handle(CtServerCore $core): int
    {
        $out = $core->canaryProbe();
        $this->info(sprintf(
            'status=%s%s',
            (string) ($out['status'] ?? 'unknown'),
            isset($out['reason']) ? ' reason='.$out['reason'] : '',
        ));

        return self::SUCCESS;
    }
}
