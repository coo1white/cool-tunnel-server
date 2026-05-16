<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;

// v0.4.0 — VLESS UUID replaces basic-auth password.
//
// sing-box's VLESS inbound authenticates by per-user UUID, not by
// basic_auth username/password. The UUID IS the credential — like an
// API key — so we store it in plain text. There's no advantage to
// encrypting at rest:
//   - The renderer needs the cleartext to write into singbox.json
//     anyway (the same posture v0.3.x took with password_cleartext_
//     encrypted, which the renderer immediately decrypted).
//   - A DB dump that already contains the encrypted form recovers to
//     cleartext under APP_KEY exposure — i.e., the encrypt-at-rest
//     wrapper added complexity but no real defence-in-depth once
//     APP_KEY is in the same volume.
// The disk-protection posture for proxy_accounts is the same as the
// rest of the DB: treat the volume as a secret.
//
// Schema change is destructive on legacy rows:
//   - DROP password_hash       (bcrypt hash, no longer authenticated)
//   - DROP password_cleartext_encrypted (Crypt-sealed, useless to sing-box)
//   - ADD uuid (char(36), unique)
//
// Backfill for existing rows: a fresh random v4 UUID per row. The
// legacy basic-auth credentials cannot re-authenticate against a sing-
// box VLESS server regardless, so preserving them would only leave
// dead data. Operators on a v0.3.x → v0.4.0 upgrade should expect to
// surface fresh UUIDs to each user post-migration (the panel's
// Filament UI exposes the per-row UUID in the regenerate flow).
//
// Backfill is done in PHP via Str::uuid() rather than `MySQL UUID()`
// so the migration is portable to SQLite (the in-memory test driver)
// which has no UUID() function.

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('proxy_accounts', function (Blueprint $table) {
            // Nullable on add so the backfill loop below can land
            // values without a default expression. After backfill we
            // add the unique index; nullable column with a unique
            // index permits multiple NULLs in both MySQL and SQLite,
            // but in practice the model layer guarantees a UUID is
            // set before save (see ProxyAccount::booted()).
            $table->char('uuid', 36)->nullable()->after('username');
        });

        foreach (DB::table('proxy_accounts')->select('id')->get() as $row) {
            DB::table('proxy_accounts')
                ->where('id', $row->id)
                ->update(['uuid' => (string) Str::uuid()]);
        }

        Schema::table('proxy_accounts', function (Blueprint $table) {
            $table->unique('uuid');
            $table->dropColumn('password_hash');
            $table->dropColumn('password_cleartext_encrypted');
        });
    }

    public function down(): void
    {
        Schema::table('proxy_accounts', function (Blueprint $table) {
            // The reverse migration cannot recover the legacy
            // password values — they were never deterministic from
            // the UUID. We restore the column shape only; any
            // operator running `migrate:rollback` here must re-seed
            // credentials manually.
            $table->string('password_hash')->nullable()->after('username');
            $table->text('password_cleartext_encrypted')->nullable()->after('password_hash');
            $table->dropUnique(['uuid']);
            $table->dropColumn('uuid');
        });
    }
};
