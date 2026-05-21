<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// v0.4.0 core-only runtime: traffic collection and quota enforcement
// were retired with the old clash API path. Drop the dead columns so
// new installs and upgraded installs expose the same account shape.

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('proxy_accounts', function (Blueprint $table) {
            $drop = [];
            if (Schema::hasColumn('proxy_accounts', 'quota_bytes')) {
                $drop[] = 'quota_bytes';
            }
            if (Schema::hasColumn('proxy_accounts', 'used_bytes')) {
                $drop[] = 'used_bytes';
            }

            if ($drop !== []) {
                $table->dropColumn($drop);
            }
        });
    }

    public function down(): void
    {
        Schema::table('proxy_accounts', function (Blueprint $table) {
            if (! Schema::hasColumn('proxy_accounts', 'quota_bytes')) {
                $table->unsignedBigInteger('quota_bytes')->nullable()->after('enabled');
            }
            if (! Schema::hasColumn('proxy_accounts', 'used_bytes')) {
                $table->unsignedBigInteger('used_bytes')->default(0)->after('quota_bytes');
            }
        });
    }
};
