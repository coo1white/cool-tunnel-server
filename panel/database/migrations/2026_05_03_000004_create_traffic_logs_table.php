<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Aggregate per-account, per-day byte counters. Caddy itself doesn't
// expose per-account accounting; this table is filled from Caddy
// access logs (when the operator enables them) or from the periodic
// rollup via `traffic:rollup` Artisan command which scrapes Caddy's
// /metrics endpoint over the unix admin socket.

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('traffic_logs', function (Blueprint $table) {
            $table->id();
            $table->foreignId('proxy_account_id')->constrained()->cascadeOnDelete();
            $table->date('day');
            $table->unsignedBigInteger('uplink_bytes')->default(0);
            $table->unsignedBigInteger('downlink_bytes')->default(0);
            $table->unsignedInteger('connections')->default(0);
            $table->timestamps();

            $table->unique(['proxy_account_id', 'day']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('traffic_logs');
    }
};
