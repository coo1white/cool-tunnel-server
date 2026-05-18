<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Services;

use App\Contracts\SingBoxReloaderInterface;

// No-op reload shim for the v0.4.0 sing-box path.
//
// v0.1.x: shelled out to `ct-server-core server reload`, which
// PUT the rendered sing-box config.json to sing-box's clash API.
// v0.2.x/v0.3.x: this compatibility interface was temporarily used
// for Caddy/naive reload paths while the architecture moved around.
// v0.4.0 restored a dedicated ct-singbox container. Its supervisor
// file-watches /data/config/singbox.json and respawns sing-box after
// the panel atomically writes a new config, so PHP has nothing to do
// after a successful render.
//
// Class name MUST stay `SingBoxReloader` for AppServiceProvider
// binding-path compatibility (`app(SingBoxReloader::class)`,
// `SingBoxReloaderInterface::class => SingBoxReloader::class`).
// Renaming the file would force a touch of every consumer.
// (Future refactor — a `CaddyReloader` alias is the cleaner
// move; cost-benefit doesn't yet justify the diff.)

class SingBoxReloader implements SingBoxReloaderInterface
{
    public function reload(): bool
    {
        return true;
    }
}
