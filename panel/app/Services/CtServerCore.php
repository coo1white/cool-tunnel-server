<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Services;

use App\Contracts\CtServerCoreInterface;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;

// Thin wrapper around the ct-server-core Rust binary.
//
// Every PHP service that still routes through ct-server-core (Caddyfile
// rendering / reloading, component manifest checks, canary probes, the
// PanelDomain SoT helper) calls into this one helper.
//
// v0.4.0 — sing-box rendering moved out of this path. The panel-side
// SingBoxConfigGenerator now shells directly to
// /usr/local/bin/singbox-core render-server (the Bun-compiled binary
// bundled in the panel container) rather than going through the Rust
// core. Traffic collection / quota enforcement / sing-box reload all
// went away with the clash admin API that sing-box VLESS+Reality
// doesn't expose.
//
// We always pass --json and parse stdout. If the exit code is non-
// zero we surface stderr to the caller.

final class CtServerCore implements CtServerCoreInterface
{
    public function __construct(
        private string $binary = 'ct-server-core',
    ) {}

    /**
     * Cap on captured stdout/stderr per call. ct-server-core's
     * happy-path output is < 1 KiB; this is generous and bounds
     * the worst case if the binary ever loops printing (e.g. a
     * regression that floods stderr from a tight loop) so the
     * panel container doesn't OOM on the captured String.
     */
    private const MAX_CAPTURE_BYTES = 1_048_576; // 1 MiB

    /**
     * Run a subcommand and return decoded JSON. Throws on non-zero
     * exit.
     *
     * @param  array<int,string>  $args
     * @return array<mixed>
     */
    public function run(array $args, int $timeoutSec = 30): array
    {
        $proc = new Process(array_merge([$this->binary, '--json'], $args));
        $proc->setTimeout($timeoutSec);
        // setIdleTimeout: if the process produces no output for
        // half the wall-time, treat as wedged. ct-server-core
        // writes to stderr regularly via tracing; an idle gap
        // longer than this is suspicious.
        $proc->setIdleTimeout(max(5, (int) floor($timeoutSec / 2)));
        $proc->run();

        if (! $proc->isSuccessful()) {
            $stderr = $this->bound($proc->getErrorOutput());
            Log::error('ct-server-core failed', [
                'args' => $args,
                'exit' => $proc->getExitCode(),
                'stderr' => $stderr,
            ]);
            throw new \RuntimeException(sprintf(
                'ct-server-core %s failed (exit %d): %s',
                implode(' ', $args),
                (int) $proc->getExitCode(),
                $stderr,
            ));
        }

        $stdout = trim($proc->getOutput());
        if ($stdout === '') {
            return [];
        }
        if (strlen($stdout) > self::MAX_CAPTURE_BYTES) {
            throw new \RuntimeException(sprintf(
                'ct-server-core %s returned %d bytes of stdout (cap %d) — refusing to parse',
                implode(' ', $args),
                strlen($stdout),
                self::MAX_CAPTURE_BYTES,
            ));
        }

        $decoded = json_decode($stdout, true);
        if (! is_array($decoded)) {
            throw new \RuntimeException(
                'ct-server-core returned non-JSON: '.$this->bound($stdout)
            );
        }

        return $decoded;
    }

    /**
     * Trim whitespace and clamp to MAX_CAPTURE_BYTES with a
     * truncation marker. Avoids logging multi-MB blobs that would
     * otherwise pin the panel's log volume.
     */
    private function bound(string $s): string
    {
        $s = trim($s);
        if (strlen($s) <= self::MAX_CAPTURE_BYTES) {
            return $s;
        }

        return substr($s, 0, self::MAX_CAPTURE_BYTES).'…[truncated]';
    }

    public function renderCaddyfile(): array
    {
        return $this->run(['caddyfile', 'render']);
    }

    // renderSingBoxConfig() / renderNaive() removed in v0.4.0 —
    // sing-box rendering is done by SingBoxConfigGenerator shelling
    // directly to /usr/local/bin/singbox-core render-server (the
    // Bun-compiled binary in the panel container), bypassing
    // ct-server-core entirely. The Rust core no longer renders proxy
    // configs at all; only the Caddyfile path remains here.

    // reloadSingBox / collectTraffic / enforceQuota removed in v0.4.0
    // — all three shelled into ct-server-core CLI paths that wrapped
    // sing-box's clash admin API; sing-box VLESS+Reality exposes no
    // clash API at all.

    /**
     * Caddy reload — graceful, zero-downtime config swap inside the
     * ct-caddy container.
     *
     * Implementation in core/ct-server-core/src/caddy/mod.rs::reload
     * shells out to `docker exec ct-caddy caddy reload --config <output>`.
     * Caddy validates the new Caddyfile BEFORE swapping; a parse
     * error leaves the running config in place. The TimeoutSec 30
     * matches the Rust-side 15s ceiling on the inner docker exec
     * with extra headroom for the docker round-trip.
     *
     * SingBoxReloader::reload() calls this in v0.2.0+ (the
     * sing-box clash-API path is retired). Class name preserved
     * for AppServiceProvider binding compatibility — see
     * SingBoxReloader.php's head comment.
     */
    public function reloadCaddy(): array
    {
        return $this->run(['caddyfile', 'reload'], timeoutSec: 30);
    }

    public function componentList(string $manifestsDir = '/srv/manifests'): array
    {
        return $this->run(['component', 'list', '--manifests', $manifestsDir]);
    }

    public function componentCheck(string $manifestsDir = '/srv/manifests'): array
    {
        return $this->run(['component', 'check', '--manifests', $manifestsDir]);
    }

    // probeAntiTracking() removed in v0.4.0 — see the head comment
    // on CtServerCoreInterface for context. The
    // /usr/local/bin/naive subprocess this method spawned is no
    // longer bundled in the panel image, and the
    // `ct-server-core probe anti-tracking` subcommand is gone.

    /**
     * Run one self-probe canary cycle.
     *
     * Returns `['exit_code' => int, 'entry' => array|null, 'stderr' => string]`
     * — NOT the throwing `run()` shape. The Rust binary
     * intentionally exits non-zero on probe failure (DoH / TCP /
     * config) so the Laravel scheduler's `onFailure` hook fires,
     * AND prints a structured JSON entry to stdout regardless. The
     * artisan caller needs both halves: the exit code drives the
     * scheduler signal, the parsed entry drives the operator-
     * facing artisan output. `run()` discards stdout when exit !=
     * 0, which would make the operator see the raw exception
     * instead of the structured "status=fail reason=..." message.
     *
     * 15-second cap covers DoH lookup (5 s) + TCP connect (5 s) +
     * write-back (~ms) with headroom.
     */
    public function canaryProbe(): array
    {
        $proc = new Process([$this->binary, '--json', 'canary', 'probe']);
        $proc->setTimeout(15);
        $proc->setIdleTimeout(8);
        $proc->run();

        $stdout = trim($proc->getOutput());
        $entry = null;
        if ($stdout !== '' && strlen($stdout) <= self::MAX_CAPTURE_BYTES) {
            $decoded = json_decode($stdout, true);
            if (is_array($decoded)) {
                $entry = $decoded;
            }
        }

        return [
            'exit_code' => (int) $proc->getExitCode(),
            'entry' => $entry,
            'stderr' => $this->bound($proc->getErrorOutput()),
        ];
    }
}
