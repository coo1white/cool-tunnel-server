<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Protocol selection for each proxy account. v0.4.0 renders
// VLESS+Reality immediately; the rest of the sing-box protocol
// catalog can be selected and signed into subscriptions as a stable
// server/client contract while their renderers land.

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('proxy_accounts', function (Blueprint $table) {
            $table->json('enabled_protocols')
                ->nullable()
                ->after('client_default_local_port');
        });
    }

    public function down(): void
    {
        Schema::table('proxy_accounts', function (Blueprint $table) {
            $table->dropColumn('enabled_protocols');
        });
    }
};
