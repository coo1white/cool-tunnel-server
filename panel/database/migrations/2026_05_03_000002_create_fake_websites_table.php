<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Cover sites the panel can render at the apex domain. One is marked
// `is_active`; the FakeSiteController renders that one for any non-
// /admin request.

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('fake_websites', function (Blueprint $table) {
            $table->id();
            $table->string('slug', 64)->unique();
            $table->string('name');
            $table->string('template')->default('blog');     // blade template key
            $table->string('title')->nullable();
            $table->string('tagline')->nullable();
            $table->json('payload')->nullable();             // theme-specific data (posts, products, etc.)
            $table->boolean('is_active')->default(false);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('fake_websites');
    }
};
