<?php

namespace App\Filament\Widgets;

use App\Models\ProxyAccount;
use App\Models\TrafficLog;
use Filament\Widgets\StatsOverviewWidget as BaseWidget;
use Filament\Widgets\StatsOverviewWidget\Stat;
use Illuminate\Support\Carbon;

class TrafficStatsWidget extends BaseWidget
{
    protected function getStats(): array
    {
        $today = Carbon::today();

        $totalToday = (int) TrafficLog::where('day', $today)
            ->selectRaw('COALESCE(SUM(uplink_bytes + downlink_bytes), 0) AS s')
            ->value('s');

        $activeAccounts = ProxyAccount::where('enabled', true)
            ->where(function ($q) {
                $q->whereNull('expires_at')->orWhere('expires_at', '>', now());
            })->count();

        $overQuota = ProxyAccount::whereNotNull('quota_bytes')
            ->whereColumn('used_bytes', '>=', 'quota_bytes')->count();

        return [
            Stat::make('Active accounts', (string) $activeAccounts),
            Stat::make('Traffic today', self::human($totalToday)),
            Stat::make('Over quota', (string) $overQuota)
                ->color($overQuota > 0 ? 'warning' : 'success'),
        ];
    }

    private static function human(int $b): string
    {
        if ($b === 0) return '0 B';
        $u = ['B','KiB','MiB','GiB','TiB'];
        $i = max(0, min((int) floor(log(max($b, 1), 1024)), 4));
        return round($b / (1024 ** $i), 2).' '.$u[$i];
    }
}
