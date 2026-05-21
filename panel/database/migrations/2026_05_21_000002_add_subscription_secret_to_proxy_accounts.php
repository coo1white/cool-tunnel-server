<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// New accounts get a subscription_secret from ProxyAccount::booted().
// Existing rows intentionally stay NULL so their already-issued
// subscription URLs keep working after an update. Rotating UUID or
// the subscription URL fills this column and revokes the legacy URL.

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('proxy_accounts', function (Blueprint $table) {
            if (! Schema::hasColumn('proxy_accounts', 'subscription_secret')) {
                $table->char('subscription_secret', 64)
                    ->nullable()
                    ->after('uuid')
                    ->unique();
            }
        });

    }

    public function down(): void
    {
        Schema::table('proxy_accounts', function (Blueprint $table) {
            if (Schema::hasColumn('proxy_accounts', 'subscription_secret')) {
                $table->dropUnique(['subscription_secret']);
                $table->dropColumn('subscription_secret');
            }
        });
    }
};
