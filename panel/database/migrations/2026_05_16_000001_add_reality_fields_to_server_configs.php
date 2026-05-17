<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// v0.4.0 — Reality (sing-box VLESS+Reality) replaces NaiveProxy /
// HTTPS-CONNECT. Four new columns on the singleton server_configs row:
//
//   reality_private_key
//     X25519 server private key, 32 bytes serialised as base64url.
//     Laravel-Crypt-encrypted at write time (AES-256-GCM); the renderer
//     decrypts at the DB-read boundary right before passing the value
//     into `singbox-core render-server`. A DB dump alone is useless
//     without APP_KEY — same threat model as v0.3.x's
//     password_cleartext_encrypted.
//
//   reality_public_key
//     Derived public key, 32 bytes base64url. Not secret — included in
//     subscription manifests so clients can pin their TLS-fake
//     handshake. Stored to avoid re-deriving on every render.
//
//   reality_dest_host
//     The cover-site sing-box forwards to when an incoming TLS handshake
//     either lacks a valid short_id or is a passive probe. Default
//     www.microsoft.com — a CDN-fronted target with stable cert chain
//     reachability worldwide. Operators can pick their own per deploy
//     (e.g. apple.com / cloudflare.com / a niche large CDN tenant).
//
//   reality_short_ids
//     JSON array of short_id strings that gate which client handshakes
//     succeed. NULL → server accepts the empty short_id only (single-
//     tenant trivial case). Future per-short-id account binding is a
//     model concern; the schema just stores the list.
//
// All four nullable on add so the migration is non-destructive on a
// fresh deploy (the panel's first-boot bootstrap fills them via
// `singbox-core reality-keygen`). The migration intentionally does NOT
// auto-generate a keypair here — that would write secrets through a
// surface migration callers don't expect (db-seeder logs, multi-tenant
// test suites, CI db:wipe runs).

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('server_configs', function (Blueprint $table) {
            $table->text('reality_private_key')->nullable()->after('http3_enabled');
            $table->string('reality_public_key', 64)->nullable()->after('reality_private_key');
            $table->string('reality_dest_host')->default('www.microsoft.com')->after('reality_public_key');
            $table->json('reality_short_ids')->nullable()->after('reality_dest_host');
        });
    }

    public function down(): void
    {
        Schema::table('server_configs', function (Blueprint $table) {
            $table->dropColumn([
                'reality_private_key',
                'reality_public_key',
                'reality_dest_host',
                'reality_short_ids',
            ]);
        });
    }
};
