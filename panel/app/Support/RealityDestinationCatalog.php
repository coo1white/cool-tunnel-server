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

        $snapshot = [
            'latency_ms' => self::measureLatencyMs($host),
            'checked_at' => time(),
        ];

        try {
            Cache::put(self::cacheKey($host), $snapshot, self::CACHE_SECONDS);
        } catch (Throwable) {
            // Cache is an optimisation only; return the fresh probe.
        }

        return $snapshot;
    }

    /**
     * Refresh the curated set plus the current custom host.
     *
     * @return array<string,array{latency_ms:int|null, checked_at:int}>
     */
    public static function refreshCatalogLatencies(?string $currentHost = null): array
    {
        $hosts = self::hostnames();
        $current = self::normalizeHost((string) $currentHost);
        if ($current !== '' && ! in_array($current, $hosts, true) && self::isValidHostname($current)) {
            $hosts[] = $current;
        }

        $results = [];
        foreach ($hosts as $host) {
            $results[$host] = self::refreshHostLatency($host);
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

    private static function cacheKey(string $host): string
    {
        return 'reality_dest_latency:'.sha1(self::normalizeHost($host));
    }
}
