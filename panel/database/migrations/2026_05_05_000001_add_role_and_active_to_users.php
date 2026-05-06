<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// H2 (2026-05-05 audit) — gate Filament admin access on `role` +
// `is_active` instead of mere row existence in `users`. Pre-fix,
// User::canAccessPanel() returned true unconditionally; any seeded
// row (or any future automated seeder) gained full ProxyAccount /
// ServerConfig / FakeWebsite authority. This migration adds the
// columns the model now checks.
//
// Existing rows are backfilled to ('admin', true) so an in-place
// upgrade does not lock out current operators. New rows default the
// same way; demote a user by `UPDATE users SET role='viewer'` (no
// admin UI for role management in v0.0.1 — operators edit by hand).

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            // ENUM-shaped via string + app-level constraint. Avoids
            // a real SQL ENUM (which MariaDB cannot ALTER cleanly
            // when the value-set grows).
            $table->string('role', 32)->default('admin')->after('password');
            $table->boolean('is_active')->default(true)->after('role');
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn(['role', 'is_active']);
        });
    }
};
