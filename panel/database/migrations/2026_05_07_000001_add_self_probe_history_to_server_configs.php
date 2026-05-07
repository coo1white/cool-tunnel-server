<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// v0.0.57 china-readiness — self-probe canary persistence.
//
// `ct-server-core canary probe` runs every 5 minutes (Laravel
// scheduler hook in panel/routes/console.php). Each run resolves
// the apex domain via the configured DoH endpoint and TCP-connects
// to :443. Result is appended here as a JSON array of
// {ts: ISO-8601, status: 'ok'|'fail', reason?: string} entries
// trimmed to the last 10. The panel reads the tail to drive a
// "last N self-probes failed" banner — early-warning signal that
// the VPS is becoming unreachable from its own network position
// (DoH blocked, haproxy down, IP poisoned, etc.) BEFORE users
// notice and complain.
//
// JSON column rather than a new self_probe_results table because:
//   - State is bounded (last 10 entries — ~1 KiB)
//   - Always queried alongside ServerConfig (singleton row)
//   - Saves a JOIN on the panel's banner-render path
//   - Trimming is in-place via JSON_ARRAY_APPEND + JSON_REMOVE,
//     no INSERT-then-DELETE-old-rows cron needed.
//
// New installs get an empty array; existing installs backfill
// the same way so the panel widget renders cleanly without
// special-casing nulls.

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('server_configs', function (Blueprint $table) {
            $table->json('self_probe_history')->nullable()->after('last_rendered_at');
        });
    }

    public function down(): void
    {
        Schema::table('server_configs', function (Blueprint $table) {
            $table->dropColumn('self_probe_history');
        });
    }
};
