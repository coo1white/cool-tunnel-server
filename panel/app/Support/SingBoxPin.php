<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Support;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Process;
use Throwable;

final class SingBoxPin
{
    private const CACHE_SECONDS = 3600;

    private const BINARY_PATH = '/usr/local/bin/singbox-core';

    /** @return array{upstream_tag:string}|null */
    public static function current(): ?array
    {
        try {
            return Cache::remember(
                'singbox_pin:current',
                self::CACHE_SECONDS,
                fn (): ?array => self::readCurrent(),
            );
        } catch (Throwable $e) {
            Log::warning('singbox.pin.cache_failed', [
                'err' => $e->getMessage(),
                'type' => $e::class,
            ]);

            return self::readCurrent();
        }
    }

    /** @return array{upstream_tag:string}|null */
    private static function readCurrent(): ?array
    {
        $committed = self::readCommittedPin();
        if ($committed !== null) {
            return $committed;
        }

        $result = Process::timeout(2)->run([self::BINARY_PATH, 'version', '--json']);
        if (! $result->successful()) {
            Log::warning('singbox.pin.version_failed', [
                'exit' => $result->exitCode(),
                'stderr' => substr(trim($result->errorOutput()), 0, 240),
            ]);

            return null;
        }

        try {
            $decoded = json_decode(trim($result->output()), true, flags: JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            Log::warning('singbox.pin.version_non_json', [
                'err' => $e->getMessage(),
            ]);

            return null;
        }

        $tag = is_array($decoded) ? (string) ($decoded['singbox_upstream'] ?? '') : '';
        if (! preg_match('/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/', $tag)) {
            Log::warning('singbox.pin.version_missing_upstream', [
                'stdout' => substr(trim($result->output()), 0, 240),
            ]);

            return null;
        }

        return ['upstream_tag' => $tag];
    }

    /** @return array{upstream_tag:string}|null */
    private static function readCommittedPin(): ?array
    {
        $path = base_path('../singbox-core/singbox.upstream.json');
        if (! is_file($path)) {
            return null;
        }

        try {
            $decoded = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);
        } catch (Throwable) {
            return null;
        }

        $tag = is_array($decoded) ? (string) ($decoded['upstream_tag'] ?? '') : '';
        if (! preg_match('/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/', $tag)) {
            return null;
        }

        return ['upstream_tag' => $tag];
    }
}
