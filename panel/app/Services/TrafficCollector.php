<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Log;

// Thin shell-out to `ct-server-core traffic collect`.
//
// The Rust core scrapes Caddy /metrics, parses Prometheus text,
// upserts traffic_logs, and bumps proxy_accounts.used_bytes — all
// in one transaction.

final class TrafficCollector
{
    public function __construct(
        private CtServerCore $core,
    ) {}

    /** Returns the number of rows touched. */
    public function rollup(): int
    {
        try {
            $out = $this->core->collectTraffic();
        } catch (\RuntimeException $e) {
            Log::warning('traffic.rollup.failed', ['err' => $e->getMessage()]);

            return 0;
        }

        return (int) ($out['rows'] ?? 0);
    }
}
