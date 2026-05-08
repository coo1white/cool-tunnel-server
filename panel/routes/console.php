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

// Roll aggregate counters from per-connection bytes into per-account
// totals every minute. Cheap because it runs against a small table.
Sched::command('traffic:rollup')->everyMinute()
    ->withoutOverlapping()
    ->onOneServer()
    ->onFailure($logFailure('traffic:rollup'));

// Disable accounts that have hit their quota or expiry. Hourly is
// fine — sing-box's basic_auth check is cheap, and 60 minutes of
// over-quota use is acceptable; tighten if you care.
Sched::command('quota:enforce')->hourly()
    ->withoutOverlapping()
    ->onFailure($logFailure('quota:enforce'));

// Re-render sing-box config + reload as a safety net in case a model
// event missed (e.g. queue worker died mid-flight).
Sched::command('singbox:render --if-changed --reload')->everyFiveMinutes()
    ->withoutOverlapping()
    ->onFailure($logFailure('singbox:render'));

// Self-probe canary — DoH-resolve apex + TCP-connect to
// haproxy:443; result writes to ServerConfig.self_probe_history
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
