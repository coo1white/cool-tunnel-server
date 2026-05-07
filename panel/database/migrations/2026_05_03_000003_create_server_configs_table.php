<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Singleton: exactly one row, id=1. Holds the values the panel
// substitutes into Caddyfile.tpl on render.

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('server_configs', function (Blueprint $table) {
            $table->id();

            // Identity / ACME
            $table->string('domain');
            $table->string('acme_email');
            $table->string('acme_directory')
                ->default('https://acme-v02.api.letsencrypt.org/directory');

            // Anti-tracking knobs
            $table->boolean('anti_tracking_hide_ip')->default(true);
            $table->boolean('anti_tracking_hide_via')->default(true);
            $table->boolean('anti_tracking_probe_resistance')->default(true);
            // DoH resolver default — AliDNS works from inside the
            // GFW where Cloudflare DoH (the prior default) is
            // intermittently blocked or silently dropped, breaking
            // sing-box's DNS path. See docs/going-to-china.md for
            // the trust / reachability matrix and how to switch
            // per deployment context.
            $table->string('anti_tracking_doh_resolver')
                ->default('https://dns.alidns.com/dns-query');

            // HTTP/3 toggle (some networks throttle UDP/443)
            $table->boolean('http3_enabled')->default(true);

            // Internal: the SHA-256 of the last successfully rendered
            // Caddyfile so the scheduler can skip reloads when nothing
            // changed.
            $table->string('last_caddyfile_hash', 64)->nullable();
            $table->timestamp('last_rendered_at')->nullable();

            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('server_configs');
    }
};
