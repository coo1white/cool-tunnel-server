<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Widgets;

use App\Models\ProxyAccount;
use App\Models\TrafficLog;
use Filament\Widgets\StatsOverviewWidget as BaseWidget;
use Filament\Widgets\StatsOverviewWidget\Stat;
use Illuminate\Support\Carbon;

class TrafficStatsWidget extends BaseWidget
{
    // Per-user traffic + quota-by-bytes are a v0.1 roadmap item under
    // sing-box. metrics::collect (core/ct-server-core/src/metrics.rs)
    // is documented as a no-op until sing-box emits per-user
    // Prometheus metrics; until then traffic_logs and proxy_accounts.
    // used_bytes never increment, so "Traffic today" is always 0 B
    // and "Over quota" is always 0. Surfacing those numbers without
    // disclosure was misleading the operator (R4-4); we keep them
    // visible so the gap is honest, mark the colour neutral, and
    // annotate the disclosure inline.
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

        $pendingNote = 'No per-user metrics under sing-box (v0.1 roadmap)';

        return [
            Stat::make('Active accounts', (string) $activeAccounts),
            Stat::make('Traffic today', self::human($totalToday))
                ->description($pendingNote)
                ->color('gray'),
            Stat::make('Over quota', (string) $overQuota)
                ->description($pendingNote)
                ->color('gray'),
        ];
    }

    private static function human(int $b): string
    {
        if ($b === 0) {
            return '0 B';
        }
        $u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        $i = max(0, min((int) floor(log(max($b, 1), 1024)), 4));

        return round($b / (1024 ** $i), 2).' '.$u[$i];
    }
}
