<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Log;

// Thin shell-out to `ct-server-core server reload`.
//
// The Rust core PUTs the rendered config.json path to sing-box's
// clash API over the unix socket — graceful, no dropped connections,
// no docker exec round-trip. Falls back to `docker compose restart
// sing-box` if the clash socket isn't reachable from the panel
// container (host-side dev with no shared volume).
//
// Class name MUST match the filename so PSR-4 autoloading resolves
// `App\Services\SingBoxReloader::class` correctly. v0.0.9 and earlier
// shipped this file declaring `class CaddyReloader`, which broke the
// `app(SingBoxReloader::class)` path bound from AppServiceProvider —
// every panel save that fired the model-saved event raised
// "Class App\Services\SingBoxReloader not found" at runtime.

class SingBoxReloader
{
    public function __construct(
        private CtServerCore $core,
    ) {}

    public function reload(): bool
    {
        try {
            $this->core->reloadSingBox();

            return true;
        } catch (\Throwable $e) {
            // Broader than \RuntimeException — see CaddyfileGenerator
            // for rationale (an undefined-method Error broke this
            // path silently between v0.0.4 and v0.0.10).
            Log::warning('singbox.reload.failed', [
                'err' => $e->getMessage(),
                'type' => get_class($e),
            ]);

            return false;
        }
    }
}
