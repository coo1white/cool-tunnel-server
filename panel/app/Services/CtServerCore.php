<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;

// Thin wrapper around the ct-server-core Rust binary.
//
// Every PHP service that used to do "real work" (SingBoxConfigGenerator,
// SingBoxReloader, TrafficCollector, ComponentChecker) now calls into
// this one helper. The Rust binary owns the latency-sensitive paths;
// PHP stays where it's good — UI and persistence orchestration.
//
// We always pass --json and parse stdout. If the exit code is non-
// zero we surface stderr to the caller.

final class CtServerCore
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

    public function renderSingBoxConfig(): array
    {
        return $this->run(['singbox', 'render']);
    }

    public function renderCaddyfile(): array
    {
        return $this->run(['caddyfile', 'render']);
    }

    public function reloadSingBox(): array
    {
        return $this->run(['server', 'reload'], timeoutSec: 60);
    }

    public function collectTraffic(): array
    {
        return $this->run(['traffic', 'collect']);
    }

    public function enforceQuota(): array
    {
        return $this->run(['quota', 'enforce']);
    }

    public function componentList(string $manifestsDir = '/srv/manifests'): array
    {
        return $this->run(['component', 'list', '--manifests', $manifestsDir]);
    }

    public function componentCheck(string $manifestsDir = '/srv/manifests'): array
    {
        return $this->run(['component', 'check', '--manifests', $manifestsDir]);
    }

    public function probeAntiTracking(?string $via, string $target): array
    {
        $args = ['probe', 'anti-tracking', '--target', $target];
        if ($via !== null) {
            array_push($args, '--via', $via);
        }

        return $this->run($args, timeoutSec: 20);
    }
}
