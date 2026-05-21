<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Support;

use Illuminate\Support\Facades\Cache;
use Throwable;

final class RealityDestinationCatalog
{
    public const DEFAULT_HOST = 'www.microsoft.com';

    private const CACHE_SECONDS = 900;

    private const PROBE_TIMEOUT_SECONDS = 0.35;

    private const PARALLEL_PROBE_SECONDS = 0.45;

    /** @var array<string,array{name:string, region:string}> */
    private const CANDIDATES = [
        'www.microsoft.com' => ['name' => 'Microsoft', 'region' => 'Global CDN'],
        'www.apple.com' => ['name' => 'Apple', 'region' => 'Global CDN'],
        'www.bing.com' => ['name' => 'Bing', 'region' => 'Global CDN'],
        'www.cloudflare.com' => ['name' => 'Cloudflare', 'region' => 'Global CDN'],
        'www.google.com' => ['name' => 'Google', 'region' => 'Global CDN'],
        'www.office.com' => ['name' => 'Microsoft 365', 'region' => 'Global CDN'],
        'www.github.com' => ['name' => 'GitHub', 'region' => 'Global CDN'],
        'www.wikipedia.org' => ['name' => 'Wikipedia', 'region' => 'Global CDN'],
        'www.yahoo.com' => ['name' => 'Yahoo', 'region' => 'Global CDN'],
        'ya.ru' => ['name' => 'Yandex', 'region' => 'RU/EU edge'],
    ];

    /** @var (callable(string): ?int)|null */
    private static $latencyProbe = null;

    /** @return list<string> */
    public static function hostnames(): array
    {
        return array_keys(self::CANDIDATES);
    }

    public static function selectDefault(?string $currentHost = null): string
    {
        $host = self::normalizeHost((string) $currentHost);

        return $host !== '' && self::isValidHostname($host) ? $host : self::DEFAULT_HOST;
    }

    /** @return array<string,string> */
    public static function selectOptions(
        ?string $currentHost = null,
        bool $measureLatency = false,
        bool $includeCachedLatency = false,
    ): array {
        $includeLatency = $measureLatency || $includeCachedLatency;
        $hosts = self::hostnames();
        $current = self::normalizeHost((string) $currentHost);
        if ($current !== '' && ! in_array($current, $hosts, true) && self::isValidHostname($current)) {
            $hosts[] = $current;
        }

        $options = [];
        foreach ($hosts as $host) {
            $snapshot = ['latency_ms' => null, 'checked_at' => null];
            if ($measureLatency) {
                $snapshot = self::refreshHostLatency($host);
            } elseif ($includeCachedLatency) {
                $snapshot = self::cachedLatency($host);
            }

            $options[$host] = self::displayLabel(
                $host,
                is_int($snapshot['latency_ms']) ? $snapshot['latency_ms'] : null,
                includeLatency: $includeLatency,
                checkedAt: is_int($snapshot['checked_at']) ? $snapshot['checked_at'] : null,
            );
        }

        return $options;
    }

    public static function isSelectableHost(string $host, ?string $currentHost = null): bool
    {
        $host = self::normalizeHost($host);
        if (array_key_exists($host, self::CANDIDATES)) {
            return true;
        }

        return $host !== ''
            && $host === self::normalizeHost((string) $currentHost)
            && self::isValidHostname($host);
    }

    public static function isValidHost(string $host): bool
    {
        return self::isValidHostname(self::normalizeHost($host));
    }

    public static function normalizeHost(string $host): string
    {
        $host = strtolower(trim($host));
        $host = preg_replace('#^https?://#', '', $host) ?? $host;
        $host = explode('/', $host, 2)[0] ?? $host;
        $host = explode(':', $host, 2)[0] ?? $host;

        return rtrim($host, '.');
    }

    public static function displayLabel(
        string $host,
        ?int $latencyMs = null,
        bool $includeLatency = true,
        ?int $checkedAt = null,
    ): string {
        $host = self::normalizeHost($host);
        $meta = self::CANDIDATES[$host] ?? ['name' => 'Current custom', 'region' => 'custom'];
        if (! $includeLatency) {
            return "{$meta['name']} ({$host}) - {$meta['region']}";
        }

        $latency = $latencyMs === null ? 'latency not checked' : "{$latencyMs} ms";
        if ($checkedAt !== null) {
            $latency .= ' checked '.date('H:i', $checkedAt);
        }

        return "{$meta['name']} ({$host}) - {$meta['region']} - {$latency}";
    }

    public static function resolveLatencyMs(string $host): ?int
    {
        $host = self::normalizeHost($host);
        if (! self::isValidHostname($host)) {
            return null;
        }

        $snapshot = self::cachedLatency($host);
        if ($snapshot['checked_at'] === null) {
            $snapshot = self::refreshHostLatency($host);
        }

        return is_int($snapshot['latency_ms']) ? $snapshot['latency_ms'] : null;
    }

    /** @return array{latency_ms:int|null, checked_at:int|null} */
    public static function cachedLatency(string $host): array
    {
        $host = self::normalizeHost($host);
        if (! self::isValidHostname($host)) {
            return ['latency_ms' => null, 'checked_at' => null];
        }

        try {
            $cached = Cache::get(self::cacheKey($host));
        } catch (Throwable) {
            return ['latency_ms' => null, 'checked_at' => null];
        }

        if (! is_array($cached)) {
            return ['latency_ms' => null, 'checked_at' => null];
        }

        $latency = $cached['latency_ms'] ?? null;
        $checkedAt = $cached['checked_at'] ?? null;

        return [
            'latency_ms' => is_int($latency) ? $latency : null,
            'checked_at' => is_int($checkedAt) ? $checkedAt : null,
        ];
    }

    /** @return array{latency_ms:int|null, checked_at:int} */
    public static function refreshHostLatency(string $host): array
    {
        $host = self::normalizeHost($host);
        if (! self::isValidHostname($host)) {
            return ['latency_ms' => null, 'checked_at' => time()];
        }

        return self::storeLatencySnapshot($host, self::measureLatencyMs($host), time());
    }

    /**
     * Refresh the curated set plus the current custom host.
     *
     * @return array<string,array{latency_ms:int|null, checked_at:int}>
     */
    public static function refreshCatalogLatencies(?string $currentHost = null): array
    {
        $hosts = self::refreshHostnames($currentHost);

        $results = [];
        $measured = self::$latencyProbe === null
            ? self::measureLatenciesConcurrently($hosts)
            : [];
        $checkedAt = time();

        foreach ($hosts as $host) {
            $results[$host] = self::storeLatencySnapshot(
                $host,
                self::$latencyProbe === null
                    ? ($measured[$host] ?? null)
                    : self::measureLatencyMs($host),
                $checkedAt,
            );
        }

        return $results;
    }

    public static function latencyStatusText(?string $host): string
    {
        $host = self::normalizeHost((string) $host);
        if ($host === '') {
            return 'No Reality destination selected.';
        }

        $snapshot = self::cachedLatency($host);
        if ($snapshot['checked_at'] === null) {
            return 'Latency not checked yet.';
        }

        if ($snapshot['latency_ms'] === null) {
            return 'Last latency check failed at '.date('H:i', $snapshot['checked_at']).'.';
        }

        return "Last latency: {$snapshot['latency_ms']} ms at ".date('H:i', $snapshot['checked_at']).'.';
    }

    public static function useLatencyProbeForTests(?callable $probe): void
    {
        self::$latencyProbe = $probe;
    }

    private static function isValidHostname(string $host): bool
    {
        return (bool) preg_match(
            '/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i',
            $host,
        );
    }

    private static function measureLatencyMs(string $host): ?int
    {
        if (self::$latencyProbe !== null) {
            return (self::$latencyProbe)($host);
        }

        $start = hrtime(true);
        $errno = 0;
        $errstr = '';
        $socket = @stream_socket_client(
            "tcp://{$host}:443",
            $errno,
            $errstr,
            self::PROBE_TIMEOUT_SECONDS,
            STREAM_CLIENT_CONNECT,
        );
        if (! is_resource($socket)) {
            return null;
        }
        fclose($socket);

        return max(1, (int) round((hrtime(true) - $start) / 1_000_000));
    }

    /** @return list<string> */
    private static function refreshHostnames(?string $currentHost): array
    {
        $hosts = self::hostnames();
        $current = self::normalizeHost((string) $currentHost);
        if ($current !== '' && ! in_array($current, $hosts, true) && self::isValidHostname($current)) {
            $hosts[] = $current;
        }

        return $hosts;
    }

    /**
     * @param  list<string>  $hosts
     * @return array<string,int|null>
     */
    private static function measureLatenciesConcurrently(array $hosts): array
    {
        $results = array_fill_keys($hosts, null);
        $pending = [];
        foreach ($hosts as $host) {
            $errno = 0;
            $errstr = '';
            $socket = @stream_socket_client(
                "tcp://{$host}:443",
                $errno,
                $errstr,
                0,
                STREAM_CLIENT_CONNECT | STREAM_CLIENT_ASYNC_CONNECT,
            );
            if (! is_resource($socket)) {
                continue;
            }

            stream_set_blocking($socket, false);
            $pending[$host] = [
                'socket' => $socket,
                'started_at' => hrtime(true),
            ];
        }

        $deadline = microtime(true) + self::PARALLEL_PROBE_SECONDS;
        while ($pending !== [] && microtime(true) < $deadline) {
            $write = [];
            foreach ($pending as $probe) {
                $write[] = $probe['socket'];
            }

            $read = [];
            $except = [];
            $remainingUs = max(1_000, (int) (($deadline - microtime(true)) * 1_000_000));
            $ready = @stream_select($read, $write, $except, 0, min($remainingUs, 50_000));
            if ($ready === false || $ready === 0) {
                continue;
            }

            foreach ($write as $socket) {
                foreach ($pending as $host => $probe) {
                    if ($probe['socket'] !== $socket) {
                        continue;
                    }

                    if (self::asyncConnectSucceeded($socket)) {
                        $results[$host] = max(1, (int) round((hrtime(true) - $probe['started_at']) / 1_000_000));
                    }
                    fclose($socket);
                    unset($pending[$host]);
                    break;
                }
            }
        }

        foreach ($pending as $probe) {
            fclose($probe['socket']);
        }

        return $results;
    }

    /**
     * A non-blocking connect becomes write-ready for both success and
     * failure. Prefer SO_ERROR when the sockets extension is present;
     * otherwise fall back to PHP's connected-peer metadata.
     *
     * @param  resource  $socket
     */
    private static function asyncConnectSucceeded($socket): bool
    {
        if (function_exists('socket_import_stream')) {
            $imported = @socket_import_stream($socket);
            if ($imported instanceof \Socket) {
                $error = @socket_get_option($imported, SOL_SOCKET, SO_ERROR);

                return $error === 0;
            }
        }

        return stream_socket_get_name($socket, true) !== false;
    }

    /** @return array{latency_ms:int|null, checked_at:int} */
    private static function storeLatencySnapshot(string $host, ?int $latencyMs, int $checkedAt): array
    {
        $snapshot = [
            'latency_ms' => $latencyMs,
            'checked_at' => $checkedAt,
        ];

        try {
            Cache::put(self::cacheKey($host), $snapshot, self::CACHE_SECONDS);
        } catch (Throwable) {
            // Cache is an optimisation only; return the fresh probe.
        }

        return $snapshot;
    }

    private static function cacheKey(string $host): string
    {
        return 'reality_dest_latency:'.sha1(self::normalizeHost($host));
    }
}
