<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

// Thin shell-out to `ct-server-core component check`.
//
// Used by the Filament Components page. We cache the result for 30
// seconds so a fast click-through doesn't hammer the DB / docker
// cli; the UI exposes a "Re-check" button to bust the cache.

final class ComponentChecker
{
    public function __construct(
        private CtServerCore $core,
    ) {}

    /**
     * @return array<int, array{name:string, installed_version:?string, pinned_version:string, state:string, message:string}>
     */
    public function check(bool $useCache = true, string $manifestsDir = '/srv/manifests'): array
    {
        if ($useCache) {
            $cached = Cache::get('components.check');
            if (is_array($cached)) {
                return $cached;
            }
        }

        try {
            $rows = $this->core->componentCheck($manifestsDir);
        } catch (\RuntimeException $e) {
            // Pre-fix the operator saw a blank Components page
            // ("0 OK / 0 NG") with NO panel-side log line — the
            // most likely cause (`ct-server-core` not on PATH on a
            // fresh deploy, or the manifests dir missing) was
            // invisible from the panel. Surface it. The page UI
            // still degrades gracefully via the empty array, but
            // the operator can now grep `component.check.failed`.
            // (Round-12 observability.)
            Log::warning('component.check.failed', [
                'err' => $e->getMessage(),
                'type' => get_class($e),
                'manifests_dir' => $manifestsDir,
            ]);
            $rows = [];
        }
        Cache::put('components.check', $rows, 30);

        return $rows;
    }

    public function summarize(array $rows): array
    {
        $ok = 0;
        $ng = 0;
        foreach ($rows as $r) {
            if (($r['state'] ?? '') === 'ok') {
                $ok++;
            } else {
                $ng++;
            }
        }

        return ['ok' => $ok, 'ng' => $ng, 'total' => count($rows)];
    }
}
