<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Jobs;

use App\Services\CaddyfileGenerator;
use App\Services\SingBoxConfigGenerator;
use App\Services\SingBoxReloader;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Log;
use Throwable;

// Slow-path render+reload backstop for ServerConfig changes. Mirror
// of ReloadSingBoxJob for the ProxyAccount path.
//
// Dual-path defense (see ServerConfig::booted):
//   1. Redis pub/sub announce stays inline — ~1ms hot path.
//   2. This job (queued) re-renders Caddyfile + sing-box config and
//      hot-reloads sing-box. Hash-idempotent at the renderer layer,
//      so racing two jobs back-to-back is a no-op-after-first.
//
// On retry exhaustion, failed() surfaces Log::critical at the
// `serverconfig.reload.job_failed` event name. The Redis fast-path
// keeps the daemon in sync even when this slow path fails, so the
// failure is panel/disk-state drift, not a security incident. See
// CHANGELOG [0.0.84] for the full rationale.
class ReloadServerConfigJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 3;

    public int $timeout = 120;

    /** @return array<int, int> */
    public function backoff(): array
    {
        return [5, 5, 5];
    }

    public function handle(
        CaddyfileGenerator $caddy,
        SingBoxConfigGenerator $singbox,
        SingBoxReloader $reloader,
    ): void {
        // Caddyfile FIRST so the operator's "I changed the panel
        // domain" case lands the new TLS cert path before sing-box
        // re-reads it on its next reload — sing-box's render hash
        // feeds in cert mtime, so the order matters for one-pass
        // reconciliation.
        $caddy->renderToFile();

        $hash = $singbox->renderToFile();
        if ($hash !== null) {
            $reloader->reload();
        }
    }

    public function failed(Throwable $e): void
    {
        Log::critical('serverconfig.reload.job_failed', [
            'tries' => $this->tries,
            'err' => $e->getMessage(),
            'type' => $e::class,
            'note' => 'all retries exhausted; rendered config + running sing-box may be out of sync. '
                .'Redis fast-path already in effect; this is the slow-path drift.',
        ]);
    }
}
