<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Services;

use App\Contracts\CaddyfileGeneratorInterface;
use Illuminate\Support\Facades\Log;

/**
 * Thin shell-out to `ct-server-core caddyfile render`.
 *
 * Caddy in this stack is ACME-only — see docs/architecture.md. The
 * Caddyfile is rendered from caddy/Caddyfile.tpl using DOMAIN /
 * ACME_EMAIL / ACME_DIRECTORY from the ServerConfig DB row. Rendering
 * happens on every ServerConfig save and on first-boot (entrypoint.sh).
 *
 * Public API mirrors {@see SingBoxConfigGenerator}: `renderToFile()`
 * returns the SHA-256 of the new file when it changed, or null when
 * the rendered output already matches what's on disk.
 */
class CaddyfileGenerator implements CaddyfileGeneratorInterface
{
    public function __construct(
        private CtServerCore $core,
    ) {}

    public function renderToFile(): ?string
    {
        try {
            $out = $this->core->renderCaddyfile();
        } catch (\Throwable $e) {
            // Catch \Throwable rather than \RuntimeException so a
            // future undefined-method / type-error / class-not-
            // found Error doesn't propagate silently up to the
            // panel and abort the surrounding model save.
            //
            // Severity is CRITICAL (was ERROR pre-v0.0.59): when
            // a Caddyfile re-render fails on ServerConfig save,
            // the surrounding save SUCCEEDS in the UI but the
            // OLD Caddyfile stays live. Domain / ACME-email /
            // ACME-directory changes silently don't take effect.
            // Operator sees green "saved" with no signal that
            // production state diverged from the panel state.
            // CRITICAL is the right level — the dashboard alarm
            // should fire. (Round-12 observability.)
            Log::critical('caddyfile.render.failed', [
                'err' => $e->getMessage(),
                'type' => get_class($e),
            ]);

            return null;
        }
        $changed = (bool) ($out['changed'] ?? false);

        return $changed ? ($out['hash'] ?? null) : null;
    }
}
