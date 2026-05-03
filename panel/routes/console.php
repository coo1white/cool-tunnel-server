<?php

use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Support\Facades\Schedule as Sched;

// Roll aggregate counters from per-connection bytes into per-account
// totals every minute. Cheap because it runs against a small table.
Sched::command('traffic:rollup')->everyMinute()
    ->withoutOverlapping()
    ->onOneServer();

// Disable accounts that have hit their quota or expiry. Hourly is
// fine — the Caddy basic_auth check is cheap, and 60 minutes of
// over-quota use is acceptable; tighten if you care.
Sched::command('quota:enforce')->hourly()
    ->withoutOverlapping();

// Re-render Caddyfile + reload as a safety net in case a model event
// missed (e.g. queue worker died mid-flight).
Sched::command('caddyfile:render --if-changed --reload')->everyFiveMinutes()
    ->withoutOverlapping();
