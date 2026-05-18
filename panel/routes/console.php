<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Schedule as Sched;

// Loud failure logging on every scheduled task (v0.0.18 — closes
// the silent-scheduler-failure gap from the loop-3 self-check).
//
// Pre-fix, a Throwable inside any of these schedules was swallowed
// by Laravel's scheduler with no log line. The most insidious
// case: `quota:enforce` throws (DB blip, ct-server-core IPC
// failure) — every over-quota user keeps tunneling forever, and
// the operator has no signal that enforcement stopped working
// until they manually inspect proxy_accounts.
//
// `Log::critical` lands at WARN-level severity in stderr → docker
// json-file (now rotated, v0.0.17), and is the loudest alert path
// short of integrating PagerDuty / OpsGenie. Operators inspecting
// `docker compose logs panel` see the schedule.failed line within
// seconds of the failure. Future improvement: a Filament widget
// that surfaces "last successful run at" per scheduled command.
$logFailure = static function (string $cmd) {
    return static function (Throwable $e) use ($cmd): void {
        Log::critical('schedule.failed', [
            'cmd' => $cmd,
            'err' => $e->getMessage(),
            'type' => get_class($e),
        ]);
    };
};

// v0.4.0 — `traffic:rollup` and `quota:enforce` scheduler entries
// removed. Both shelled into `ct-server-core {traffic,quota} ...`
// CLI subcommands that read from sing-box's clash admin API; v0.4.0
// sing-box VLESS+Reality exposes no clash API at all, so per-user
// traffic + quota enforcement moves out of the Rust core. Operator-
// side instrumentation (out-of-stack metrics, manual quota review)
// is the v0.4.0 interim posture until a sing-box-native equivalent
// surface is wired (post-v0.4.0 roadmap).

// Re-render sing-box config as a safety net in case a model event
// missed (e.g. queue worker died mid-flight). ct-singbox's
// supervisor file-watch handles reloads when the file changes.
Sched::command('singbox:render --if-changed')->everyFiveMinutes()
    ->withoutOverlapping()
    ->onFailure($logFailure('singbox:render'));

// Self-probe canary — DoH-resolve apex + TCP-connect to
// caddy:443; result writes to ServerConfig.self_probe_history
// for the panel to surface as a "last N failed" banner (operator-
// facing context: docs/going-to-china.md).
//
// withoutOverlapping is mandatory: a stalled DoH lookup in tick
// N must not stack with tick N+1's probe (would skew the
// consecutive-failure heuristic). Failure here logs but does NOT
// alert — the banner itself is the operator-visible signal;
// logging at critical would mean every China-side DoH outage
// produces a noise spike in the panel container's stderr.
Sched::command('canary:probe')->everyFiveMinutes()
    ->withoutOverlapping()
    ->onFailure($logFailure('canary:probe'));
