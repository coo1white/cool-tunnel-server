<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Services;

use App\Contracts\SingBoxConfigGeneratorInterface;
use App\Models\ProxyAccount;
use App\Models\ServerConfig;
use App\Support\RealityDestinationCatalog;
use App\Support\RenderResult;
use App\Support\SingBoxProtocolCatalog;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;

// v0.4.0+ — shells to `/usr/local/bin/singbox-core render-server` with
// a JSON `ServerRenderInput` on stdin. The Bun-compiled binary
// validates the input, renders the VLESS+Reality config.json, and
// atomic-writes to /data/config/singbox.json (the mount ct-singbox's
// supervisor file-watches).
//
// Why singbox-core (Bun TS) and NOT ct-server-core (Rust)?
//
// - Single source of truth across server + client. The same source
//   in singbox-core/ compiles to the binary the macOS app ships
//   (cool-tunnel/Resources/singbox-core). A future protocol pivot is
//   one renderer change, not two.
//
// - Reality keypair + UUID secrets enter the binary on stdin and
//   never touch the filesystem outside the panel container. The
//   pre-v0.4.0 path went through ct-server-core, which had to read
//   encrypted credentials directly from MySQL — keeping the DB
//   APP_KEY ambient in the Rust process. Moving the decrypt to PHP
//   (via Laravel's `encrypted` cast at attribute-access time) and
//   the render to a stdin-fed binary shrinks the trust surface.
//
// Public API: `renderToFile()` returns an explicit changed /
// unchanged / failed result. Keeping those states separate prevents
// a failed TypeScript renderer subprocess from being treated like a
// cheap no-op by handlers and commands.

class SingBoxConfigGenerator implements SingBoxConfigGeneratorInterface
{
    /**
     * Bundled singbox-core binary path. Matches the COPY destination
     * in docker/panel/Dockerfile's runtime stage.
     */
    private const BINARY_PATH = '/usr/local/bin/singbox-core';

    /**
     * Output target — mounted as a shared volume between the panel
     * (writer) and ct-singbox (reader). See docker-compose.yml's
     * singbox_config volume; ct-singbox's `singbox-core supervise`
     * file-watches this path and respawns sing-box on change.
     */
    private const OUTPUT_PATH = '/data/config/singbox.json';

    /**
     * Render is bounded — sing-box config emission is sub-10ms for
     * any realistic account count. A multi-second wedge means
     * something is wrong with the binary itself.
     */
    private const TIMEOUT_SEC = 15;

    public function renderToFile(): RenderResult
    {
        // Build-side failures are code defects (a missing column, a
        // corrupt cast, an unset Reality keypair). Re-throw so the
        // surrounding save / handler fails with a 500 and the
        // operator sees the bug — matches the prior \Error semantics.
        // We deliberately do NOT catch here.
        $input = $this->buildRenderInput();

        $proc = new Process([
            self::BINARY_PATH, 'render-server',
            '--output', self::OUTPUT_PATH,
            '--json',
        ]);
        $proc->setInput(
            json_encode($input, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?: '{}'
        );
        $proc->setTimeout(self::TIMEOUT_SEC);
        $proc->setIdleTimeout(self::TIMEOUT_SEC);

        try {
            $proc->run();
        } catch (\Throwable $e) {
            // Severity CRITICAL: when a sing-box re-render fails on
            // account create / delete / regen, the surrounding save
            // SUCCEEDS in the UI but the OLD config stays live in
            // sing-box. The newly-created user can't connect (not in
            // sing-box's user list); a deleted/disabled user can
            // still connect. The panel and the running proxy diverge
            // silently. CRITICAL is the right level — the dashboard
            // alarm should fire.
            Log::critical('singbox.render.process_failed', [
                'err' => $e->getMessage(),
                'type' => $e::class,
            ]);

            return RenderResult::failed();
        }
        if (! $proc->isSuccessful()) {
            Log::critical('singbox.render.nonzero_exit', [
                'exit' => $proc->getExitCode(),
                'stderr' => substr(trim($proc->getErrorOutput()), 0, 240),
            ]);

            return RenderResult::failed();
        }

        $stdout = trim($proc->getOutput());
        if ($stdout === '') {
            Log::critical('singbox.render.empty_outcome', []);

            return RenderResult::failed();
        }
        $outcome = json_decode($stdout, true);
        if (! is_array($outcome)) {
            Log::critical('singbox.render.non_json_outcome', [
                'stdout' => substr($stdout, 0, 240),
            ]);

            return RenderResult::failed();
        }

        $changed = (bool) ($outcome['changed'] ?? false);
        if (! $changed) {
            return RenderResult::unchanged();
        }

        $hash = $outcome['sha256'] ?? null;
        if (! is_string($hash) || ! preg_match('/^[0-9a-f]{64}$/i', $hash)) {
            Log::critical('singbox.render.invalid_hash', [
                'sha256' => is_scalar($hash) ? (string) $hash : gettype($hash),
            ]);

            return RenderResult::failed();
        }

        return RenderResult::changed($hash);
    }

    /**
     * Assemble the `ServerRenderInput` JSON that singbox-core's
     * render-server subcommand expects on stdin. Mirrors the
     * TypeScript interface in singbox-core/src/config/render.ts.
     *
     * Reality private key is Laravel-Crypt-decrypted at attribute-
     * access time via the `encrypted` cast on ServerConfig.
     */
    private function buildRenderInput(): array
    {
        $cfg = ServerConfig::current();

        $privateKey = (string) ($cfg->reality_private_key ?? '');
        if ($privateKey === '') {
            throw new \RuntimeException(
                'reality_private_key is empty — run reality-keygen and persist '.
                'the keypair onto the singleton ServerConfig row before rendering.'
            );
        }

        $destHost = RealityDestinationCatalog::normalizeHost((string) $cfg->reality_dest_host);
        if (! RealityDestinationCatalog::isValidHost($destHost)) {
            throw new \RuntimeException('reality_dest_host is invalid');
        }

        // PHPStan can't see through the eloquent-cast type for
        // reality_short_ids; spell the narrowing out as in
        // SubscriptionController.
        /** @var array<int,mixed> $shortIds */
        $shortIds = is_array($cfg->reality_short_ids)
            ? array_values($cfg->reality_short_ids)
            : [];
        // The renderer always wants at least one short_id; the empty
        // string is the conventional "no short_id challenge" entry.
        $normalizedShortIds = $shortIds === []
            ? ['']
            : array_map('strval', $shortIds);

        // Only enabled, non-expired accounts with the core
        // VLESS+Reality mode get rendered into singbox.json. sing-box
        // trusts its config; the panel decides which accounts are in.
        // ProxyAccount::isActive() carries the canonical live rule.
        $accounts = [];
        foreach (ProxyAccount::query()->orderBy('id')->get() as $account) {
            if (! $account->isActive()) {
                continue;
            }
            if (! in_array(SingBoxProtocolCatalog::VLESS_REALITY, $account->enabledProtocolKeys(), true)) {
                continue;
            }
            $uuid = (string) ($account->uuid ?? '');
            if ($uuid === '') {
                continue;
            }
            $accounts[] = [
                'username' => $account->username,
                'uuid' => $uuid,
            ];
        }
        if (empty($accounts)) {
            // singbox-core's render-server validator rejects empty
            // accounts[] (sing-box's vless inbound requires at least
            // one user). Seed a placeholder no real client will match.
            // The panel UI surfaces "0 active accounts" elsewhere;
            // this branch just keeps the file syntactically valid.
            $accounts[] = [
                'username' => '__no_active_accounts__',
                'uuid' => '00000000-0000-0000-0000-000000000000',
            ];
        }

        return [
            'domain' => $cfg->domain,
            'listen_port' => 443,
            'reality_private_key' => $privateKey,
            'reality_short_ids' => $normalizedShortIds,
            'reality_dest_host' => $destHost,
            'reality_dest_port' => 443,
            'accounts' => $accounts,
            'log_level' => 'info',
            'direct_domain_strategy' => (string) config(
                'cool-tunnel.singbox_direct_domain_strategy',
                'prefer_ipv4'
            ),
            'direct_connect_timeout' => (string) config(
                'cool-tunnel.singbox_direct_connect_timeout',
                '2s'
            ),
            'direct_fallback_delay' => (string) config(
                'cool-tunnel.singbox_direct_fallback_delay',
                '100ms'
            ),
        ];
    }
}
