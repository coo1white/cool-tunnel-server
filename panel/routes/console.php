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
// case: `singbox:render` throws (DB blip, renderer failure) — a
// queued render can be missed until the next schedule tick, and the
// operator has no signal unless it is logged loudly.
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

// v0.4.0 — old traffic/quota scheduler entries are retired. Both
// depended on the old clash admin API, which the current
// VLESS+Reality runtime does not expose.

// Re-render sing-box config as a safety net in case a model event
// missed (e.g. queue worker died mid-flight). ct-singbox's
// supervisor file-watch handles reloads when the file changes.
Sched::command('singbox:render --if-changed')->everyFiveMinutes()
    ->withoutOverlapping()
    ->onFailure($logFailure('singbox:render'));
