<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Log;

// Thin shell-out to `ct-server-core singbox render`.
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
//
// v0.0.9 and earlier called $this->core->renderCaddyfile() from
// here (a copy-paste from the actual CaddyfileGenerator that
// matched the file name), which raised "method not found" Error
// at runtime on every panel save. Now correctly calls
// renderSingBoxConfig().

class SingBoxConfigGenerator
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
            $out = $this->core->renderSingBoxConfig();
        } catch (\Throwable $e) {
            // Catch \Throwable rather than \RuntimeException so a
            // future undefined-method / type-error / class-not-
            // found Error doesn't propagate silently up to the
            // panel and abort the surrounding model save.
            Log::error('singbox.render.failed', [
                'err'  => $e->getMessage(),
                'type' => get_class($e),
            ]);
            return null;
        }
        // ct-server-core --json singbox render emits {hash, bytes,
        // changed, active_users, path}. We only need the hash for
        // the existing contract.
        $changed = (bool) ($out['changed'] ?? false);
        return $changed ? ($out['hash'] ?? null) : null;
    }
}
