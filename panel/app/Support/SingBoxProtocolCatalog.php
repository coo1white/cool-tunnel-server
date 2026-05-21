<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Support;

use App\Models\ServerConfig;

final class SingBoxProtocolCatalog
{
    public const VLESS_REALITY = 'vless_reality';

    /** @var array<string,array{name:string,type:string,role:string,transport:string,status:string,requires:list<string>,default?:bool}> */
    private const DEFINITIONS = [
        self::VLESS_REALITY => [
            'name' => 'VLESS + Reality',
            'type' => 'vless',
            'role' => 'server_inbound',
            'transport' => 'tcp',
            'status' => 'rendered',
            'requires' => ['uuid', 'reality public key', 'reality dest_host'],
            'default' => true,
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
        $rawKeys = self::rawKeys($value);
        $keys = [];
        foreach ($rawKeys as $key) {
            if (array_key_exists($key, self::DEFINITIONS) && ! in_array($key, $keys, true)) {
                $keys[] = $key;
            }
        }

        if ($keys === [] && $rawKeys === [] && $defaultWhenEmpty) {
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
        return in_array(self::VLESS_REALITY, $keys, true);
    }

    public static function modeSummary(mixed $value, bool $defaultWhenEmpty = true): string
    {
        $rendered = [];

        foreach (self::normaliseSelected($value, $defaultWhenEmpty) as $key) {
            $definition = self::DEFINITIONS[$key] ?? null;
            if ($definition === null) {
                continue;
            }

            $rendered[] = $definition['name'];
        }

        if ($rendered === []) {
            return 'No active core mode';
        }

        return implode(', ', $rendered).' active';
    }

    /**
     * @param  list<string>  $selected
     * @return list<array<string,mixed>>
     */
    public static function manifestFor(
        array $selected,
        ?ServerConfig $config = null,
        ?string $realityDestHost = null,
    ): array {
        $entries = [];
        foreach (self::normaliseSelected($selected) as $key) {
            $entries[] = self::manifestEntry($key, $config, $realityDestHost);
        }

        return $entries;
    }

    /** @return array<string,mixed> */
    private static function manifestEntry(
        string $key,
        ?ServerConfig $config,
        ?string $realityDestHost,
    ): array {
        $definition = self::DEFINITIONS[$key];
        $entry = [
            'key' => $key,
            'type' => $definition['type'],
            'name' => $definition['name'],
            'role' => $definition['role'],
            'transport' => $definition['transport'],
            'status' => $definition['status'],
            'usable' => true,
            'requires' => $definition['requires'],
        ];

        $target = self::latencyTarget($key, $config, $realityDestHost);
        if ($target !== null) {
            $entry['latency_target'] = "{$target['host']}:{$target['port']}";
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

        return null;
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
