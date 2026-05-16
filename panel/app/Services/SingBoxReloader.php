<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Services;

use App\Contracts\SingBoxReloaderInterface;
use Illuminate\Support\Facades\Log;

// Thin shell-out to `ct-server-core caddyfile reload` (v0.2.0+).
//
// v0.1.x: shelled out to `ct-server-core server reload`, which
// PUT the rendered sing-box config.json to sing-box's clash API.
// v0.2.0 collapsed sing-box and HAProxy into Caddy+forwardproxy;
// the reload primitive moved to `docker exec ct-caddy caddy
// reload --config /etc/caddy/Caddyfile`, called from
// CtServerCore::reloadCaddy(). Caddy validates the new config
// before swapping; in-flight connections drain gracefully; no
// dropped TLS handshakes on a config bump.
//
// Class name MUST stay `SingBoxReloader` for AppServiceProvider
// binding-path compatibility (`app(SingBoxReloader::class)`,
// `SingBoxReloaderInterface::class => SingBoxReloader::class`).
// Renaming the file would force a touch of every consumer.
// (Future refactor — a `CaddyReloader` alias is the cleaner
// move; cost-benefit doesn't yet justify the diff.)

class SingBoxReloader implements SingBoxReloaderInterface
{
    public function __construct(
        private CtServerCore $core,
    ) {}

    public function reload(): bool
    {
        try {
            $this->core->reloadCaddy();

            return true;
        } catch (\Throwable $e) {
            // Broader than \RuntimeException — see CaddyfileGenerator
            // for rationale (an undefined-method Error broke this
            // path silently between v0.0.4 and v0.0.10).
            Log::warning('caddy.reload.failed', [
                'err' => $e->getMessage(),
                'type' => get_class($e),
            ]);

            return false;
        }
    }
}
