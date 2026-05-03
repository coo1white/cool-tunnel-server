<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\Cache;

// Thin shell-out to `ct-server-core component check`.
//
// Used by the Filament Components page. We cache the result for 30
// seconds so a fast click-through doesn't hammer the DB / docker
// cli; the UI exposes a "Re-check" button to bust the cache.

final class ComponentChecker
{
    public function __construct(
        private CtServerCore $core,
    ) {
    }

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
        } catch (\RuntimeException) {
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
            if (($r['state'] ?? '') === 'ok') $ok++;
            else                              $ng++;
        }
        return ['ok' => $ok, 'ng' => $ng, 'total' => count($rows)];
    }
}
