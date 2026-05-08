<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// sing-box's `naive` inbound checks the basic_auth password directly
// (not as a hash), so we have to keep the cleartext at rest.
// Encrypted with Laravel's Crypt at write time; the panel and the
// Rust core both have APP_KEY available via .env.
//
// Threat-model note: a DB dump now contains all proxy passwords in
// the encrypted-at-rest form. Anyone with both the DB dump AND the
// APP_KEY recovers cleartext. The DB volume should be treated like
// a secret — same posture as before, just the surface is wider.

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('proxy_accounts', function (Blueprint $table) {
            // Laravel-encrypted (AES-256-GCM) base64 payload — variable
            // length, ~4× the plaintext, so 1024 chars is plenty for
            // any realistic password. Nullable because legacy rows
            // (pre-sing-box) don't have it; the panel forces a regen
            // on first save after migration.
            $table->text('password_cleartext_encrypted')->nullable()->after('password_hash');
        });
    }

    public function down(): void
    {
        Schema::table('proxy_accounts', function (Blueprint $table) {
            $table->dropColumn('password_cleartext_encrypted');
        });
    }
};
