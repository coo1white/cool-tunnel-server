<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Support;

use Illuminate\Support\Facades\Cache;
use Throwable;

final class RealityDestinations
{
    public const DEFAULT_HOST = 'www.microsoft.com';

    private const CACHE_SECONDS = 600;

    private const PROBE_TIMEOUT_SECONDS = 0.35;

    /** @var array<string,array{name:string, region:string}> */
    private const CANDIDATES = [
        'www.microsoft.com' => ['name' => 'Microsoft', 'region' => 'Global CDN'],
        'www.apple.com' => ['name' => 'Apple', 'region' => 'Global CDN'],
        'www.cloudflare.com' => ['name' => 'Cloudflare', 'region' => 'Global CDN'],
        'www.bing.com' => ['name' => 'Bing', 'region' => 'Global CDN'],
        'www.yahoo.com' => ['name' => 'Yahoo', 'region' => 'Global CDN'],
        'ya.ru' => ['name' => 'Yandex', 'region' => 'RU/EU edge'],
    ];

    /** @return list<string> */
    public static function hosts(): array
    {
        return array_keys(self::CANDIDATES);
    }

    public static function selectDefault(?string $currentHost = null): string
    {
        $host = self::normaliseHost((string) $currentHost);

        return $host !== '' && self::isValidHostname($host) ? $host : self::DEFAULT_HOST;
    }

    /** @return array<string,string> */
    public static function options(?string $currentHost = null, bool $measureLatency = true): array
    {
        $hosts = self::hosts();
        $current = self::normaliseHost((string) $currentHost);
        if ($current !== '' && ! in_array($current, $hosts, true) && self::isValidHostname($current)) {
            $hosts[] = $current;
        }

        $options = [];
        foreach ($hosts as $host) {
            $options[$host] = self::label($host, $measureLatency ? self::latencyMs($host) : null);
        }

        return $options;
    }

    public static function isSelectableHost(string $host, ?string $currentHost = null): bool
    {
        $host = self::normaliseHost($host);
        if (array_key_exists($host, self::CANDIDATES)) {
            return true;
        }

        return $host !== ''
            && $host === self::normaliseHost((string) $currentHost)
            && self::isValidHostname($host);
    }

    public static function isValidHost(string $host): bool
    {
        return self::isValidHostname(self::normaliseHost($host));
    }

    public static function normaliseHost(string $host): string
    {
        $host = strtolower(trim($host));
        $host = preg_replace('#^https?://#', '', $host) ?? $host;
        $host = explode('/', $host, 2)[0] ?? $host;
        $host = explode(':', $host, 2)[0] ?? $host;

        return rtrim($host, '.');
    }

    public static function label(string $host, ?int $latencyMs = null): string
    {
        $host = self::normaliseHost($host);
        $meta = self::CANDIDATES[$host] ?? ['name' => 'Current custom', 'region' => 'custom'];
        $latency = $latencyMs === null ? 'latency unavailable' : "{$latencyMs} ms";

        return "{$meta['name']} ({$host}) - {$meta['region']} - {$latency}";
    }

    public static function latencyMs(string $host): ?int
    {
        $host = self::normaliseHost($host);
        if (! self::isValidHostname($host)) {
            return null;
        }

        $key = 'reality_dest_latency:'.sha1($host);
        try {
            return Cache::remember($key, self::CACHE_SECONDS, fn () => self::measureLatencyMs($host));
        } catch (Throwable) {
            return self::measureLatencyMs($host);
        }
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
}
