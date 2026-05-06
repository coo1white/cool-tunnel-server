<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\TrafficCollector;
use Illuminate\Console\Command;

class TrafficRollup extends Command
{
    protected $signature = 'traffic:rollup';

    protected $description = 'Pull metrics from Caddy and roll into traffic_logs';

    public function handle(TrafficCollector $tc): int
    {
        $rows = $tc->rollup();
        $this->info("rolled up {$rows} accounts");

        return self::SUCCESS;
    }
}
