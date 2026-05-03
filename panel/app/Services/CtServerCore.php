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
    ) {
    }

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
        $proc->run();

        if (! $proc->isSuccessful()) {
            Log::error('ct-server-core failed', [
                'args'   => $args,
                'exit'   => $proc->getExitCode(),
                'stderr' => trim($proc->getErrorOutput()),
            ]);
            throw new \RuntimeException(sprintf(
                'ct-server-core %s failed (exit %d): %s',
                implode(' ', $args),
                (int) $proc->getExitCode(),
                trim($proc->getErrorOutput()),
            ));
        }

        $stdout = trim($proc->getOutput());
        if ($stdout === '') {
            return [];
        }

        $decoded = json_decode($stdout, true);
        if (! is_array($decoded)) {
            throw new \RuntimeException(
                "ct-server-core returned non-JSON: {$stdout}"
            );
        }
        return $decoded;
    }

    public function renderSingBoxConfig(): array
    {
        return $this->run(['singbox', 'render']);
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
