<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasColumn('users', 'must_change_password')) {
            return;
        }

        Schema::table('users', function (Blueprint $table) {
            $table->boolean('must_change_password')->default(false)->after('is_active');
        });
    }

    public function down(): void
    {
        if (! Schema::hasColumn('users', 'must_change_password')) {
            return;
        }

        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn('must_change_password');
        });
    }
};
