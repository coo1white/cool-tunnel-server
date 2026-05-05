<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Services\SingBoxConfigGenerator;
use App\Services\SingBoxReloader;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

// R-panel-1 (2026-05-05 audit) — pre-fix, ProxyAccount::booted ran
// SingBoxConfigGenerator::renderToFile() and SingBoxReloader::reload()
// SYNCHRONOUSLY inside the model save callback. A hung
// ct-server-core (60s subprocess timeout) blocked the Filament
// request for the same 60s. The bulk-delete table action fired N
// renders/reloads serially: an admin clicking "delete 50 expired
// accounts" stalled the whole panel for minutes.
//
// Two-layer defense behind this refactor:
//
//   1. The fast path stays inline in booted(): the Redis revocation
//      pub/sub announce. ct-server-core's daemon picks it up in
//      ~1ms via the cool_tunnel:revocations channel and runs
//      through the Coalescer (≤2 reloads per 100ms window
//      regardless of burst size). That layer alone delivers the
//      ≤100ms hot path operators feel.
//
//   2. The slow path — the panel-side render+reload backstop — moves
//      here. The job is idempotent (SingBoxConfigGenerator dedupes
//      by SHA-256 inside renderToFile, and the daemon's coalescer
//      deduplicates a second time on the wire), so racing two of
//      them is a no-op-after-first.
//
// Queue connection / worker:
//   The default queue connection is `database` (config/queue.php
//   line 6); the `jobs` table migrated at 0001_01_01_000002.
//   docker/panel/supervisord.conf already runs
//   `php artisan queue:work --sleep=1 --tries=3 --max-time=3600`
//   under the [program:queue] block — no docker-compose change
//   needed to land this refactor.
//
// Failure semantics:
//   tries=3 with fixed 5s backoff. A persistent failure ends up in
//   `failed_jobs` (database-uuids driver, config/queue.php). The
//   Redis fast-path means the daemon already revoked the
//   compromised credential by the time the slow-path worker has
//   exhausted retries — the queue is the consistency layer, not
//   the security layer.

class ReloadSingBoxJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    /**
     * Maximum number of retry attempts before the job lands in
     * `failed_jobs`. Three is enough to ride out a brief
     * ct-server-core restart without flooding the table.
     */
    public int $tries = 3;

    /**
     * Per-try wall-clock cap. ct-server-core's reloadSingBox()
     * subprocess sets its own 60s timeout in CtServerCore.php;
     * give the worker another 30s to log the failure cleanly.
     */
    public int $timeout = 90;

    /**
     * Constant 5s backoff between retries. Reload contention is
     * usually a races-with-itself problem (two saves hit at once),
     * not an exponential-backoff-shaped outage; 5s is enough for
     * the prior reload to complete.
     *
     * @return array<int, int>
     */
    public function backoff(): array
    {
        return [5, 5, 5];
    }

    /**
     * The queued unit of work: re-render config.json on disk and,
     * if the file actually changed, ask sing-box to hot-reload.
     *
     * Runs with no constructor arguments — the job is
     * representation-free because it always reads the current DB
     * state. Two saved-events queued back-to-back coalesce
     * naturally: the first job renders + reloads with the latest
     * state, the second renders the same hash and short-circuits
     * inside renderToFile().
     */
    public function handle(
        SingBoxConfigGenerator $generator,
        SingBoxReloader $reloader,
    ): void {
        $hash = $generator->renderToFile();
        if ($hash !== null) {
            $reloader->reload();
        }
    }

    /**
     * Stable job key — Laravel uses this when grouping retry/fail
     * metrics. Returning a constant means the dashboard shows one
     * line for "sing-box reload" rather than one per fire.
     */
    public function uniqueId(): string
    {
        return 'sing-box-reload';
    }
}
