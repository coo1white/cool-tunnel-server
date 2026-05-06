<?php

declare(strict_types=1);

namespace App\Services;

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
class CaddyfileGenerator
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
            Log::error('caddyfile.render.failed', [
                'err' => $e->getMessage(),
                'type' => get_class($e),
            ]);

            return null;
        }
        $changed = (bool) ($out['changed'] ?? false);

        return $changed ? ($out['hash'] ?? null) : null;
    }
}
