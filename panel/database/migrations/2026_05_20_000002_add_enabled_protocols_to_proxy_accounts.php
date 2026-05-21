<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Protocol selection for each proxy account. The current core runtime
// renders VLESS+Reality only. The nullable JSON column remains so
// legacy/stale rows can be detected and displayed without silently
// granting access.

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
