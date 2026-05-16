<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Services;

use App\Contracts\CtServerCoreInterface;
use App\Contracts\NaiveConfigGeneratorInterface;
use Illuminate\Support\Facades\Log;

// Thin shell-out to `ct-server-core naive render`.
//
// v0.3.0+ replacement for the v0.2.x basic_auth-in-Caddyfile path.
// The rendered file lands at /data/config/naive.json (mounted in
// docker-compose.yml as the `naive_config` volume) where ct-naive's
// Bun supervisor file-watches it and respawns the naive child.
//
// Why a parallel class to CaddyfileGenerator instead of folding it
// into the existing renderer: failure modes diverge. A failed
// Caddyfile render lands the operator at "domain or ACME change
// silently didn't propagate"; a failed naive render lands the
// operator at "credential rotation silently didn't propagate to the
// proxy." Both deserve their own critical-log key for dashboards,
// and the symmetry with CaddyfileGenerator / SingBoxConfigGenerator
// keeps the test pattern uniform.

class NaiveConfigGenerator implements NaiveConfigGeneratorInterface
{
    public function __construct(
        private CtServerCoreInterface $core,
    ) {}

    public function renderToFile(): ?string
    {
        try {
            $out = $this->core->renderNaive();
        } catch (\Throwable $e) {
            // Severity CRITICAL — same posture as
            // CaddyfileGenerator / SingBoxConfigGenerator. When a
            // naive re-render fails on a credential change, the
            // surrounding Filament save SUCCEEDS but the OLD
            // naive.json stays on disk; ct-naive's supervisor
            // keeps the OLD naive process running with the OLD
            // credential. A newly-created or password-rotated
            // account can't connect; a disabled account can still
            // connect. The dashboard alarm SHOULD fire.
            Log::critical('naive.render.failed', [
                'err' => $e->getMessage(),
                'type' => get_class($e),
            ]);

            // \Error (TypeError, undefined-method, etc.) signals a
            // code defect; re-throw so the save 500s and the
            // operator sees the bug rather than a silently-diverged
            // panel/proxy state. \Exception subclasses
            // (\RuntimeException from CtServerCore::run on non-zero
            // exit) stay soft-failed via return-null. Same posture
            // as the sibling generators — drift would be its own
            // bug class.
            if ($e instanceof \Error) {
                throw $e;
            }

            return null;
        }

        $changed = (bool) ($out['changed'] ?? false);

        return $changed ? ($out['hash'] ?? null) : null;
    }
}
