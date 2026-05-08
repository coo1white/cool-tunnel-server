<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// One row per proxy user. Caddy's forward_proxy expects a bcrypt hash
// per basic_auth line in the Caddyfile, so we only ever store the
// hash — cleartext is shown to the admin once at creation.

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('proxy_accounts', function (Blueprint $table) {
            $table->id();
            $table->string('username', 64)->unique();
            $table->string('password_hash');                 // bcrypt
            $table->string('label')->nullable();             // free-form note
            $table->boolean('enabled')->default(true);
            $table->unsignedBigInteger('quota_bytes')->nullable(); // null = unlimited
            $table->unsignedBigInteger('used_bytes')->default(0);  // rolling total
            $table->timestamp('expires_at')->nullable();
            $table->timestamp('last_seen_at')->nullable();
            $table->json('metadata')->nullable();            // anti-tracking overrides, etc.
            $table->timestamps();

            $table->index(['enabled', 'expires_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('proxy_accounts');
    }
};
