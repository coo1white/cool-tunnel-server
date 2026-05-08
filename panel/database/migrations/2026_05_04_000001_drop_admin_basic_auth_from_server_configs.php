<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Drop the admin_basic_auth_user / admin_basic_auth_hash columns
// from server_configs. The "edge auth (extra layer in front of
// /admin)" feature these backed never actually enforced anything
// in the post-v0.0.4 stack: no middleware read the values, the
// Caddyfile had no basic_auth directive on a panel-facing block,
// and the only consumer was clash_secret(). R4-2 in
// docs/audits/2026-05-04T06-31-58Z.md.
//
// Idempotent via hasColumn — fresh installs run the upstream
// create_server_configs migration without these columns; existing
// installs run this drop.

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('server_configs', function (Blueprint $table) {
            if (Schema::hasColumn('server_configs', 'admin_basic_auth_user')) {
                $table->dropColumn('admin_basic_auth_user');
            }
            if (Schema::hasColumn('server_configs', 'admin_basic_auth_hash')) {
                $table->dropColumn('admin_basic_auth_hash');
            }
        });
    }

    public function down(): void
    {
        Schema::table('server_configs', function (Blueprint $table) {
            if (! Schema::hasColumn('server_configs', 'admin_basic_auth_user')) {
                $table->string('admin_basic_auth_user')->nullable();
            }
            if (! Schema::hasColumn('server_configs', 'admin_basic_auth_hash')) {
                $table->string('admin_basic_auth_hash')->nullable();
            }
        });
    }
};
