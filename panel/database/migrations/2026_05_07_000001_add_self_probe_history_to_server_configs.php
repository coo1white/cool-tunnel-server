<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Self-probe canary persistence column.
//
// `ct-server-core canary probe` runs every 5 minutes (Laravel
// scheduler hook in panel/routes/console.php) and appends a
// JSON entry — `{ts: ISO-8601, status: 'ok'|'fail', reason?: string}`
// — trimmed in-place to the last 10 entries via JSON_ARRAY_APPEND
// + JSON_REMOVE in a single UPDATE (see canary::append_history).
// The panel reads the tail to drive a "last N self-probes failed"
// banner — early-warning that the VPS is becoming unreachable
// from its own network position (DoH blocked, haproxy down, IP
// poisoned, etc.) before users complain.
//
// JSON column on the singleton ServerConfig row rather than a
// new table: state is bounded (~1 KiB at MAX_HISTORY=10), always
// queried alongside ServerConfig, and the in-place JSON trim is
// cheaper than INSERT-plus-old-row-DELETE.
//
// Nullable + `coalesce(self_probe_history, '[]'::json)` on read.
// Both new and existing installs land with NULL until the first
// canary tick fires; readers must treat null and empty array the
// same. The model casts the column as `array` so PHP callers see
// `null` until the first write — Filament widgets / future banner
// code should null-check before iterating.

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
