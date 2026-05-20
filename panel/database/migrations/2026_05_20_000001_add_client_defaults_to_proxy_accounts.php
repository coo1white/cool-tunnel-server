<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Per-account client defaults that are safe to refresh from the
// subscription manifest. The current macOS client treats localPort as
// a client-side preference, but carrying a server-side default lets
// operators pre-fill new devices without changing the VLESS credential
// contract.

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('proxy_accounts', function (Blueprint $table) {
            $table->unsignedSmallInteger('client_default_local_port')
                ->default(1080)
                ->after('enabled');
        });
    }

    public function down(): void
    {
        Schema::table('proxy_accounts', function (Blueprint $table) {
            $table->dropColumn('client_default_local_port');
        });
    }
};
