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

// v0.0.84 robustness-review fix (item 7) — promotes the slow-path
// portion of `App\Models\ServerConfig::booted::updated` into a
// queued job, mirroring the v0.0.x ReloadSingBoxJob refactor that
// did the same for ProxyAccount.
//
// Pre-fix, `ServerConfig::booted::updated` ran THREE shell-outs
// inline inside the Filament request lifecycle:
//
//   1. CaddyfileGenerator::renderToFile()    (ct-server-core child)
//   2. SingBoxConfigGenerator::renderToFile() (ct-server-core child)
//   3. SingBoxReloader::reload()              (clash-API HTTP call)
//
// Each of the two render shell-outs swallows any \Throwable to a
// `Log::critical` and returns null. The Filament page's `save()`
// method then unconditionally showed a green notification
// ("Caddyfile + sing-box config regenerated; both services
// hot-reloading"), so an operator who hit a transient
// ct-server-core hang during the upgrade window saw "saved
// successfully" while the on-disk config still reflected the
// previous state. The Octane worker's request was also blocked
// for the full 60s subprocess timeout if any of the three calls
// hung, costing one of the (small number of) workers for the
// duration.
//
// Two-layer defense behind this refactor — same shape as the
// ProxyAccount counterpart:
//
//   1. The fast path stays inline in ServerConfig::booted: the
//      Redis revocation pub/sub announce
//      (announceServerConfigChanged). ct-server-core's daemon
//      picks it up in ~1ms and runs through the Coalescer (≤2
//      reloads per 100ms window regardless of burst size). That
//      layer alone delivers the ≤100ms hot path operators feel.
//
//   2. The slow path — the panel-side render+reload backstop —
//      moves here. The job is idempotent: both renderToFile()
//      calls dedupe via SHA-256 inside the renderer, the daemon's
//      Coalescer dedupes a second time on the wire, and racing
//      two jobs back-to-back is a no-op-after-first.
//
// Caddy reload is implicit: CaddyfileGenerator::renderToFile()
// writes the new Caddyfile atomically; Caddy picks it up via its
// admin-API file-watch path. If the operator changed the domain,
// Caddy obtains a fresh cert via ACME on its next boot; the cert
// mtime feeds into the sing-box render hash so the next sing-box
// render naturally re-fires after renewal.
//
// Failure semantics:
//   tries=3 with constant 5s backoff (mirrors ReloadSingBoxJob).
//   On exhaustion the job lands in `failed_jobs` and the
//   `failed()` handler emits Log::critical at the documented
//   `serverconfig.reload.job_failed` event name. Dashboards can
//   alarm on that. The Redis fast-path already keeps the daemon
//   in sync with the new config, so a slow-path failure is a
//   panel/disk-state drift, not a security incident — but
//   operators MUST see it surfaced.
class ReloadServerConfigJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    /**
     * Maximum retry attempts before the job lands in `failed_jobs`.
     * Three is enough to ride out a brief ct-server-core restart
     * or a clash-API blip without flooding the table.
     */
    public int $tries = 3;

    /**
     * Per-try wall-clock cap. Two ct-server-core renders +
     * one clash-API reload plus headroom for log lines and
     * final commit. Stays under the supervisor's
     * --max-time=3600 worker recycle envelope.
     */
    public int $timeout = 120;

    /**
     * Constant 5s backoff between retries. The realistic failure
     * mode is "two renders raced" or "ct-server-core restarting
     * for an upgrade" — neither benefits from exponential
     * backoff; both clear within seconds.
     *
     * @return array<int, int>
     */
    public function backoff(): array
    {
        return [5, 5, 5];
    }

    /**
     * The queued unit of work: re-render Caddyfile and sing-box
     * config from the current DB state, then ask sing-box to
     * hot-reload if its config actually changed.
     *
     * Representation-free (no constructor args) — always reads
     * the current DB state. Two saved-events queued back-to-back
     * coalesce naturally: the first job renders + reloads with
     * the latest state, the second renders the same hash and
     * short-circuits inside renderToFile().
     */
    public function handle(
        CaddyfileGenerator $caddy,
        SingBoxConfigGenerator $singbox,
        SingBoxReloader $reloader,
    ): void {
        // Render order doesn't matter for correctness — both
        // renderers are independent and idempotent — but render
        // Caddyfile FIRST so the operator's "I changed the panel
        // domain" case lands the new TLS cert path before sing-
        // box re-reads it on its next reload. (If we rendered
        // sing-box first, the next sing-box reload would still
        // point at the old cert path until the Caddy file change
        // settled and Caddy issued a fresh cert.)
        $caddy->renderToFile();

        $hash = $singbox->renderToFile();
        if ($hash !== null) {
            $reloader->reload();
        }
    }

    /**
     * On retry exhaustion, surface the failure at CRITICAL so
     * operator dashboards alarm. Without this handler the only
     * signal would be `php artisan queue:failed` from the panel
     * container shell — invisible from the panel UI, invisible
     * to dashboards, easy to miss.
     *
     * The Redis fast-path keeps the daemon in sync with the new
     * config even when this slow-path fails, so this is NOT a
     * security incident — but it leaves the panel's rendered
     * config and the running sing-box config potentially
     * diverged. The next ServerConfig save (or the every-5-min
     * `singbox:render --if-changed --reload` scheduled command)
     * is the next chance to reconcile, and neither tells the
     * operator they're carrying drift.
     *
     * Pin the event name `serverconfig.reload.job_failed` so
     * dashboards can match it deterministically; pin the context
     * shape (tries / err / type / note) for the same reason.
     */
    public function failed(Throwable $e): void
    {
        Log::critical('serverconfig.reload.job_failed', [
            'tries' => $this->tries,
            'err' => $e->getMessage(),
            'type' => get_class($e),
            'note' => 'all retries exhausted; rendered config + running sing-box may be out of sync. '
                .'Redis fast-path already in effect; this is the slow-path drift.',
        ]);
    }
}
