<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\ComponentChecker;
use Illuminate\Console\Command;

class ComponentCheck extends Command
{
    protected $signature = 'component:check {--no-cache : Bypass the 30s cache}';

    protected $description = 'Run ct-server-core component check and print the OK/NG table';

    public function handle(ComponentChecker $checker): int
    {
        $rows = $checker->check(useCache: ! $this->option('no-cache'));
        $this->table(
            ['Status', 'Component', 'Pinned', 'Installed', 'Message'],
            collect($rows)->map(fn ($r) => [
                $r['state'] === 'ok' ? 'OK' : 'NG',
                $r['name'],
                $r['pinned_version'],
                $r['installed_version'] ?? '—',
                $r['message'],
            ])->all(),
        );
        $summary = $checker->summarize($rows);
        $this->info("OK: {$summary['ok']}  NG: {$summary['ng']}  Total: {$summary['total']}");

        return $summary['ng'] === 0 ? self::SUCCESS : self::FAILURE;
    }
}
