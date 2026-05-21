<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Support;

use App\Models\ServerConfig;
use Illuminate\Support\Facades\Cache;
use Throwable;

final class SingBoxProtocolCatalog
{
    public const VLESS_REALITY = 'vless_reality';

    private const CACHE_SECONDS = 600;

    private const PROBE_TIMEOUT_SECONDS = 0.35;

    /** @var array<string,array{name:string,type:string,role:string,transport:string,status:string,requires:list<string>,default?:bool}> */
    private const DEFINITIONS = [
        'shadowsocks' => [
            'name' => 'Shadowsocks',
            'type' => 'shadowsocks',
            'role' => 'server_inbound',
            'transport' => 'tcp_udp',
            'status' => 'catalog',
            'requires' => ['method', 'password', 'dedicated listener'],
        ],
        'vmess' => [
            'name' => 'VMess',
            'type' => 'vmess',
            'role' => 'server_inbound',
            'transport' => 'tcp',
            'status' => 'catalog',
            'requires' => ['uuid', 'dedicated listener'],
        ],
        self::VLESS_REALITY => [
            'name' => 'VLESS + Reality',
            'type' => 'vless',
            'role' => 'server_inbound',
            'transport' => 'tcp',
            'status' => 'rendered',
            'requires' => ['uuid', 'reality public key', 'reality dest_host'],
            'default' => true,
        ],
        'trojan' => [
            'name' => 'Trojan',
            'type' => 'trojan',
            'role' => 'server_inbound',
            'transport' => 'tcp',
            'status' => 'catalog',
            'requires' => ['password', 'TLS certificate', 'dedicated listener'],
        ],
        'hysteria' => [
            'name' => 'Hysteria',
            'type' => 'hysteria',
            'role' => 'server_inbound',
            'transport' => 'udp_quic',
            'status' => 'catalog',
            'requires' => ['auth secret', 'TLS certificate', 'UDP listener'],
        ],
        'hysteria2' => [
            'name' => 'Hysteria2',
            'type' => 'hysteria2',
            'role' => 'server_inbound',
            'transport' => 'udp_quic',
            'status' => 'catalog',
            'requires' => ['password', 'TLS certificate', 'UDP listener'],
        ],
        'tuic' => [
            'name' => 'TUIC',
            'type' => 'tuic',
            'role' => 'server_inbound',
            'transport' => 'udp_quic',
            'status' => 'catalog',
            'requires' => ['uuid', 'password', 'TLS certificate', 'UDP listener'],
        ],
        'wireguard' => [
            'name' => 'WireGuard',
            'type' => 'wireguard',
            'role' => 'endpoint_or_outbound',
            'transport' => 'udp',
            'status' => 'catalog',
            'requires' => ['keypair', 'address pool', 'endpoint routing'],
        ],
        'tor' => [
            'name' => 'Tor',
            'type' => 'tor',
            'role' => 'client_outbound',
            'transport' => 'overlay',
            'status' => 'catalog',
            'requires' => ['client outbound route'],
        ],
        'ssh' => [
            'name' => 'SSH',
            'type' => 'ssh',
            'role' => 'client_outbound',
            'transport' => 'tcp',
            'status' => 'catalog',
            'requires' => ['remote SSH server', 'user credential'],
        ],
        'naive' => [
            'name' => 'NaiveProxy',
            'type' => 'naive',
            'role' => 'server_inbound',
            'transport' => 'tcp',
            'status' => 'catalog',
            'requires' => ['username/password', 'TLS certificate', 'dedicated listener'],
        ],
    ];

    /** @return list<string> */
    public static function keys(): array
    {
        return array_keys(self::DEFINITIONS);
    }

    /** @return list<string> */
    public static function defaultKeys(): array
    {
        return array_values(array_filter(
            self::keys(),
            fn (string $key): bool => (bool) (self::DEFINITIONS[$key]['default'] ?? false),
        ));
    }

    /** @return list<string> */
    public static function normaliseSelected(mixed $value, bool $defaultWhenEmpty = true): array
    {
        $keys = [];
        foreach (self::rawKeys($value) as $key) {
            if (array_key_exists($key, self::DEFINITIONS) && ! in_array($key, $keys, true)) {
                $keys[] = $key;
            }
        }

        if ($keys === [] && $defaultWhenEmpty) {
            return self::defaultKeys();
        }

        return $keys;
    }

    /** @return list<string> */
    public static function invalidKeys(mixed $value): array
    {
        return array_values(array_filter(
            self::rawKeys($value),
            fn (string $key): bool => ! array_key_exists($key, self::DEFINITIONS),
        ));
    }

    /** @param list<string> $keys */
    public static function hasRenderedProtocol(array $keys): bool
    {
        foreach ($keys as $key) {
            if ((self::DEFINITIONS[$key]['status'] ?? null) === 'rendered') {
                return true;
            }
        }

        return false;
    }

    public static function modeSummary(mixed $value, bool $defaultWhenEmpty = true): string
    {
        $rendered = [];
        $staged = [];

        foreach (self::normaliseSelected($value, $defaultWhenEmpty) as $key) {
            $definition = self::DEFINITIONS[$key] ?? null;
            if ($definition === null) {
                continue;
            }

            if ($definition['status'] === 'rendered') {
                $rendered[] = $definition['name'];
            } else {
                $staged[] = $definition['name'];
            }
        }

        if ($rendered === [] && $staged === []) {
            return 'No protocol mode selected';
        }

        $parts = [];
        if ($rendered === []) {
            $parts[] = 'No active rendered mode';
        } else {
            $parts[] = implode(', ', $rendered).' active';
        }
        if ($staged !== []) {
            $parts[] = implode(', ', $staged).' staged';
        }

        return implode('; ', $parts);
    }

    /** @return array<string,string> */
    public static function options(
        ?ServerConfig $config = null,
        ?string $realityDestHost = null,
        bool $measureLatency = true,
    ): array {
        $options = [];
        foreach (self::keys() as $key) {
            $options[$key] = self::label($key, $config, $realityDestHost, $measureLatency);
        }

        return $options;
    }

    public static function label(
        string $key,
        ?ServerConfig $config = null,
        ?string $realityDestHost = null,
        bool $measureLatency = true,
    ): string {
        $definition = self::DEFINITIONS[$key] ?? null;
        if ($definition === null) {
            return $key;
        }

        $status = $definition['status'] === 'rendered'
            ? 'rendered now'
            : 'catalog staged';
        $latency = 'latency unavailable';
        $target = self::latencyTarget($key, $config, $realityDestHost);
        if ($target !== null) {
            $latencyMs = $measureLatency ? self::latencyMs($target['host'], $target['port']) : null;
            $targetText = "{$target['host']}:{$target['port']}";
            $latency = $latencyMs === null
                ? "latency unavailable to {$targetText}"
                : "{$latencyMs} ms to {$targetText}";
        }

        return "{$definition['name']} ({$definition['type']}) - {$status} - {$definition['transport']} - {$latency}";
    }

    /**
     * @param  list<string>  $selected
     * @return list<array<string,mixed>>
     */
    public static function manifestFor(
        array $selected,
        ?ServerConfig $config = null,
        ?string $realityDestHost = null,
        bool $measureLatency = true,
    ): array {
        $entries = [];
        foreach (self::normaliseSelected($selected) as $key) {
            $entries[] = self::manifestEntry($key, $config, $realityDestHost, $measureLatency);
        }

        return $entries;
    }

    /** @return array<string,mixed> */
    private static function manifestEntry(
        string $key,
        ?ServerConfig $config,
        ?string $realityDestHost,
        bool $measureLatency,
    ): array {
        $definition = self::DEFINITIONS[$key];
        $entry = [
            'key' => $key,
            'type' => $definition['type'],
            'name' => $definition['name'],
            'role' => $definition['role'],
            'transport' => $definition['transport'],
            'status' => $definition['status'],
            'usable' => $definition['status'] === 'rendered',
            'requires' => $definition['requires'],
        ];

        $target = self::latencyTarget($key, $config, $realityDestHost);
        if ($target !== null) {
            $entry['latency_target'] = "{$target['host']}:{$target['port']}";
            $latency = $measureLatency ? self::latencyMs($target['host'], $target['port']) : null;
            if ($latency !== null) {
                $entry['latency_ms'] = $latency;
            }
        }

        return $entry;
    }

    /** @return array{host:string,port:int}|null */
    private static function latencyTarget(
        string $key,
        ?ServerConfig $config,
        ?string $realityDestHost,
    ): ?array {
        if ($key === self::VLESS_REALITY) {
            $host = RealityDestinations::normaliseHost(
                (string) ($realityDestHost ?: ($config->reality_dest_host ?? RealityDestinations::DEFAULT_HOST)),
            );

            return $host === '' ? null : ['host' => $host, 'port' => 443];
        }

        $definition = self::DEFINITIONS[$key] ?? null;
        if ($definition === null || $definition['transport'] !== 'tcp') {
            return null;
        }

        $host = (string) ($config->domain ?? '');

        return $host === '' ? null : ['host' => $host, 'port' => 443];
    }

    private static function latencyMs(string $host, int $port): ?int
    {
        $host = RealityDestinations::normaliseHost($host);
        if (! RealityDestinations::isValidHost($host) || $port < 1 || $port > 65535) {
            return null;
        }

        $key = 'singbox_protocol_latency:'.sha1("{$host}:{$port}");
        try {
            return Cache::remember($key, self::CACHE_SECONDS, fn () => self::measureLatencyMs($host, $port));
        } catch (Throwable) {
            return self::measureLatencyMs($host, $port);
        }
    }

    private static function measureLatencyMs(string $host, int $port): ?int
    {
        $start = hrtime(true);
        $errno = 0;
        $errstr = '';
        $socket = @stream_socket_client(
            "tcp://{$host}:{$port}",
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
    private static function rawKeys(mixed $value): array
    {
        if ($value === null || $value === '') {
            return [];
        }
        if (is_string($value)) {
            $decoded = json_decode($value, true);
            if (is_array($decoded)) {
                $value = $decoded;
            } else {
                $value = preg_split('/\s*,\s*/', $value) ?: [];
            }
        }
        if (! is_array($value)) {
            return [];
        }
        $assocBooleanMap = array_filter(
            $value,
            fn (mixed $item, mixed $key): bool => is_string($key) && is_bool($item),
            ARRAY_FILTER_USE_BOTH,
        );
        if ($assocBooleanMap !== []) {
            return array_values(array_filter(array_map(
                fn (string $key): string => strtolower(trim($key)),
                array_keys(array_filter($assocBooleanMap)),
            ), fn (string $item): bool => $item !== ''));
        }

        return array_values(array_filter(array_map(
            fn (mixed $item): string => strtolower(trim((string) $item)),
            $value,
        ), fn (string $item): bool => $item !== ''));
    }
}
