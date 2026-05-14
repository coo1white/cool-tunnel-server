<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Jobs;

use App\Messages\ReloadSingBox;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Messenger\MessageBusInterface;
use Throwable;

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
//   The shipped `.env.example` ships `QUEUE_CONNECTION=redis`, so
//   in production this job lands on the Redis-backed connection
//   (config/queue.php → 'redis'). The `database` connection is
//   the framework default if no env override is set, and the
//   migrations include the `jobs` table (0001_01_01_000002) so a
//   bare-metal dev who doesn't set QUEUE_CONNECTION still gets a
//   working queue. docker/panel/supervisord.conf already runs
//   `php artisan queue:work --sleep=1 --tries=3 --max-time=3600`
//   under the [program:queue] block — no docker-compose change
//   needed to land this refactor.
//
// Idempotency under collision:
//   This job is *not* `ShouldBeUnique` (or `ShouldBeUniqueUntilProcessing`).
//   A naive ShouldBeUnique with a non-trivial uniqueFor would
//   create a TOCTOU race: a save landing between the lock-acquire
//   on dispatch and the DB-read at run-time would have its
//   dispatch silently dropped while not yet visible to the running
//   handler — that account would never make it into config.json.
//   Instead, idempotency is enforced one layer down at
//   SingBoxConfigGenerator::renderToFile: it computes the SHA-256
//   of the rendered output, compares against the last persisted
//   hash, and short-circuits the disk write + clash-API reload
//   when they match. Two queued workers running back-to-back with
//   the same DB state cost one extra subprocess invocation and
//   one extra hash comparison — bounded, correct, race-free.
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
     * v0.0.93 transition shim: the actual render+reload work has
     * moved to `App\MessageHandlers\ReloadSingBoxHandler`. This
     * `handle()` body now bridges the legacy Laravel-Queue
     * dispatch surface into the Symfony Messenger bus so
     * existing call sites (`ReloadSingBoxJob::dispatch()` from
     * model observers, Filament actions, scheduled commands)
     * continue to work unchanged through the v0.0.93 → v0.0.94
     * transition window.
     *
     * Phase 3 (v0.0.94) updates the call sites to dispatch
     * `new ReloadSingBox()` directly to the bus and deletes
     * this Job class.
     *
     * Note: this `handle()` still runs inside Laravel's queue
     * worker (`[program:queue]` in supervisord). The dispatched
     * message immediately enters Messenger's `async` Redis
     * transport, where `[program:messenger]` picks it up and
     * invokes the handler. The two-hop path is intentional and
     * temporary — the alternative (route the legacy dispatch
     * straight into Messenger's sync transport from inside
     * Laravel's queue worker) loses the async semantics for
     * exactly the call sites we're trying to migrate.
     */
    public function handle(MessageBusInterface $bus): void
    {
        $bus->dispatch(new ReloadSingBox(reason: 'legacy-job-bridge'));
    }

    /**
     * Round-30 queue-retry-semantics audit. Pre-this, when 3
     * retries exhausted (e.g. ct-server-core hung repeatedly,
     * sing-box clash-API unreachable for >15 s, db-connection
     * collapsed mid-render), the job landed in `failed_jobs`
     * with NO panel-side log. The operator's symptom would be
     * "I deleted account X but my client still connects" —
     * with no diagnostic surface other than `php artisan
     * queue:failed` from the container shell.
     *
     * The Redis fast-path keeps the credential revoked even when
     * this slow-path fails, so this is NOT a security-impacting
     * bug today. But it leaves the panel state and the running
     * sing-box config diverged: the next ServerConfig save (or
     * the every-5-min `singbox:render --if-changed --reload`
     * scheduled command) is the next chance to reconcile, and
     * neither tells the operator they're carrying drift.
     *
     * Critical-level log so dashboard alarms fire on this. The
     * exception class + message are logged so the operator can
     * grep `singbox.reload.job_failed` and see whether to chase
     * the daemon, the clash-API, or the DB.
     */
    public function failed(Throwable $e): void
    {
        Log::critical('singbox.reload.job_failed', [
            'tries' => $this->tries,
            'err' => $e->getMessage(),
            'type' => get_class($e),
            'note' => 'all retries exhausted; sing-box config + DB may be out of sync. '
                .'Redis fast-path already revoked credentials; this is the slow-path drift.',
        ]);
    }
}
