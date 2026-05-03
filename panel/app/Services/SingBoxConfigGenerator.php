<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Log;

// Thin shell-out to `ct-server-core caddyfile render`.
//
// Why we don't render in PHP anymore:
// - The Rust core does atomic-write with fsync, type-validated DB
//   reads, and structured error reporting in <50ms — cheaper and
//   safer than the equivalent PHP.
// - Any future client core (iOS/Android/Win/Linux) needs the same
//   logic; sharing it via the Rust binary keeps the contract single-
//   sourced.
//
// Public API is preserved so model events that previously called
// renderToFile() / render() still work.

class CaddyfileGenerator
{
    public function __construct(
        private CtServerCore $core,
    ) {
    }

    /**
     * Render to disk. Returns the new file's SHA-256 if it changed,
     * or null if the on-disk file already matches.
     */
    public function renderToFile(): ?string
    {
        try {
            $out = $this->core->renderCaddyfile();
        } catch (\RuntimeException $e) {
            Log::error('caddyfile.render.failed', ['err' => $e->getMessage()]);
            return null;
        }
        // ct-server-core --json caddyfile render emits {hash, bytes,
        // changed, accounts, path}. We only need the hash for the
        // existing contract.
        $changed = (bool) ($out['changed'] ?? false);
        return $changed ? ($out['hash'] ?? null) : null;
    }
}
