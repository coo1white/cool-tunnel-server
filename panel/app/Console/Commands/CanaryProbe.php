<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\CtServerCore;
use Illuminate\Console\Command;

class CanaryProbe extends Command
{
    protected $signature = 'canary:probe';

    protected $description = 'Run one self-probe canary cycle (DoH-resolve apex + TCP-connect to haproxy:443); appends to ServerConfig.self_probe_history';

    public function handle(CtServerCore $core): int
    {
        // canaryProbe() captures stdout BOTH on success and on
        // probe failure (the Rust binary exits non-zero on probe
        // failure but still prints the structured JSON entry to
        // stdout first, so the panel reads the same wire shape
        // regardless). The exit code drives our scheduler-side
        // signal: returning Command::FAILURE makes Laravel's
        // scheduler `onFailure(...)` hook fire (logs
        // schedule.failed) without us re-throwing.
        $out = $core->canaryProbe();
        $entry = $out['entry'] ?? null;

        if ($entry !== null) {
            $this->info(sprintf(
                'status=%s%s',
                (string) ($entry['status'] ?? 'unknown'),
                isset($entry['reason']) ? ' reason='.$entry['reason'] : '',
            ));
        } else {
            // No parseable JSON on stdout — surface stderr instead
            // so the operator can see what went wrong (e.g., binary
            // missing, panic before the println, malformed write).
            $this->error('canary probe produced no JSON output; stderr: '.$out['stderr']);
        }

        return $out['exit_code'] === 0 ? self::SUCCESS : self::FAILURE;
    }
}
