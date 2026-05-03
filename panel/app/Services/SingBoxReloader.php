<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Log;

// Thin shell-out to `ct-server-core caddy reload`.
//
// The Rust core POSTs the rendered Caddyfile to Caddy's admin API
// over the unix socket — graceful, no dropped connections, no
// docker exec round-trip.

class CaddyReloader
{
    public function __construct(
        private CtServerCore $core,
    ) {
    }

    public function reload(): bool
    {
        try {
            $this->core->reloadCaddy();
            return true;
        } catch (\RuntimeException $e) {
            Log::warning('caddy.reload.failed', ['err' => $e->getMessage()]);
            return false;
        }
    }
}
