<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Keep the immediately-previous VLESS UUID briefly after an operator
// regenerates a proxy account. The subscription manifest still emits only
// the fresh UUID; this grace row is only rendered into sing-box so old client
// sockets can drain while the user imports the new URL.

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('proxy_accounts', function (Blueprint $table) {
            if (! Schema::hasColumn('proxy_accounts', 'previous_uuid')) {
                $table->char('previous_uuid', 36)
                    ->nullable()
                    ->after('uuid');
            }
            if (! Schema::hasColumn('proxy_accounts', 'previous_uuid_valid_until')) {
                $table->timestamp('previous_uuid_valid_until')
                    ->nullable()
                    ->after('previous_uuid')
                    ->index();
            }
        });
    }

    public function down(): void
    {
        Schema::table('proxy_accounts', function (Blueprint $table) {
            if (Schema::hasColumn('proxy_accounts', 'previous_uuid_valid_until')) {
                $table->dropIndex(['previous_uuid_valid_until']);
                $table->dropColumn('previous_uuid_valid_until');
            }
            if (Schema::hasColumn('proxy_accounts', 'previous_uuid')) {
                $table->dropColumn('previous_uuid');
            }
        });
    }
};
