<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Support;

use Illuminate\Support\Facades\Log;
use Throwable;

final class ClientRuntimeCatalog
{
    /** @return array<string,mixed>|null */
    public static function current(): ?array
    {
        $path = base_path('../manifests/client-runtime.upstream.json');
        if (! is_file($path)) {
            return null;
        }

        try {
            $decoded = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);
        } catch (Throwable $e) {
            Log::warning('client_runtime_catalog.read_failed', [
                'err' => $e->getMessage(),
                'type' => $e::class,
            ]);

            return null;
        }

        if (! is_array($decoded) || ! self::isServerOwnedPortableCatalog($decoded)) {
            Log::warning('client_runtime_catalog.invalid_shape');

            return null;
        }

        return $decoded;
    }

    /** @param array<string,mixed> $catalog */
    private static function isServerOwnedPortableCatalog(array $catalog): bool
    {
        $serverRepo = 'https://github.com/coo1white/cool-tunnel-server';
        if (($catalog['name'] ?? null) !== 'client-runtime') {
            return false;
        }
        if (($catalog['kind'] ?? null) !== 'portable-runtime') {
            return false;
        }
        if (($catalog['schema_version'] ?? null) !== 1) {
            return false;
        }
        if (($catalog['upstream'] ?? null) !== $serverRepo) {
            return false;
        }
        if (! is_array($catalog['authority'] ?? null)) {
            return false;
        }
        if (($catalog['authority']['repo'] ?? null) !== $serverRepo) {
            return false;
        }
        if (($catalog['authority']['checksum_asset'] ?? null) !== 'SHA256SUMS') {
            return false;
        }

        $releaseTag = $catalog['authority']['release_tag'] ?? null;
        if (! is_string($releaseTag) || $releaseTag !== 'v'.($catalog['version'] ?? '')) {
            return false;
        }

        if (! is_array($catalog['plugins'] ?? null)) {
            return false;
        }
        $plugins = array_keys($catalog['plugins']);
        sort($plugins);
        if ($plugins !== ['cool-tunnel-core', 'sing-box']) {
            return false;
        }

        foreach (['sing-box', 'cool-tunnel-core'] as $plugin) {
            if (! self::hasValidPlugin($catalog['plugins'][$plugin], $plugin, $serverRepo, $releaseTag)) {
                return false;
            }
        }

        return true;
    }

    private static function hasValidPlugin(mixed $entry, string $plugin, string $serverRepo, string $releaseTag): bool
    {
        if (! is_array($entry)) {
            return false;
        }
        if (($entry['kind'] ?? null) !== 'binary') {
            return false;
        }
        if (($entry['upstream'] ?? null) !== $serverRepo) {
            return false;
        }
        if (! is_array($entry['assets']['darwin-universal'] ?? null)) {
            return false;
        }

        $asset = $entry['assets']['darwin-universal'];
        if (($asset['platform'] ?? null) !== 'darwin-universal') {
            return false;
        }
        if (($asset['os'] ?? null) !== 'darwin') {
            return false;
        }
        if (($asset['arch'] ?? null) !== 'universal') {
            return false;
        }
        if (! is_string($asset['url'] ?? null) || ! is_string($asset['filename'] ?? null)) {
            return false;
        }
        if (basename((string) parse_url($asset['url'], PHP_URL_PATH)) !== $asset['filename']) {
            return false;
        }
        if (! str_starts_with($asset['url'], $serverRepo.'/releases/download/'.$releaseTag.'/')) {
            return false;
        }
        if (! is_string($asset['sha256'] ?? null) || preg_match('/^[0-9a-f]{64}$/', $asset['sha256']) !== 1) {
            return false;
        }
        if (! is_int($asset['size_bytes'] ?? null) || $asset['size_bytes'] <= 1024 * 1024) {
            return false;
        }

        return match ($plugin) {
            'sing-box' => str_starts_with($asset['filename'], 'sing-box-v')
                && str_ends_with($asset['filename'], '-darwin-universal'),
            'cool-tunnel-core' => str_starts_with($asset['filename'], 'cool-tunnel-core-v')
                && ! str_ends_with($asset['filename'], '-universal'),
            default => false,
        };
    }
}
