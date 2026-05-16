<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Services;

use App\Contracts\NaivePinReaderInterface;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Exception\RuntimeException as ProcessRuntimeException;
use Symfony\Component\Process\Process;

// NaivePinReader — surface the server's current naive-binary pin so
// the subscription manifest can carry it to the client (v0.3.0+
// "same upstream tag on both ends" runtime confirmation, even
// though the two halves ship different per-OS binaries with
// different SHAs).
//
// Two sources of truth:
//   - upstream_tag : manifests/naive.upstream.json::upstream_tag.
//     This is the canonical build-time pin. operator/sync-naive-pin.ts
//     keeps docker/{naive,panel}/Dockerfile ARG defaults aligned to
//     this file, so this value IS what the panel image (and ct-naive)
//     were built against.
//   - naive_version : `/usr/local/bin/naive --version`. The panel
//     image bundles the same upstream naive binary as the ct-naive
//     container does (operator/sync-naive-pin.ts enforces equality
//     at build time). Shelling out to it locally avoids cross-
//     container exec / docker-socket coupling — same answer, no
//     extra plumbing.
//
// Result is cached for 30 seconds; the underlying files and binary
// don't change without a rebuild + restart anyway, so the TTL is a
// belt-and-braces on the hot-path cost.

final class NaivePinReader implements NaivePinReaderInterface
{
    private const CACHE_KEY = 'naive.pin';

    private const CACHE_TTL_SECONDS = 30;

    public function __construct(
        private readonly string $manifestPath = '/srv/manifests/naive.upstream.json',
        private readonly string $binaryPath = '/usr/local/bin/naive',
    ) {}

    /**
     * Return ['upstream_tag' => ..., 'naive_version' => ...] when
     * BOTH halves are readable; null otherwise. Optional on the
     * wire (skip_serializing_if=Option::is_none on the Rust side),
     * so partial reads collapse to "absent" rather than served as
     * half-truthy.
     *
     * @return array{upstream_tag:string, naive_version:string}|null
     */
    public function read(bool $useCache = true): ?array
    {
        if ($useCache) {
            $cached = Cache::get(self::CACHE_KEY);
            if (is_array($cached)) {
                return $cached;
            }
        }

        $tag = $this->readManifestTag();
        $version = $this->readBinaryVersion();
        if ($tag === null || $version === null) {
            return null;
        }
        $pin = ['upstream_tag' => $tag, 'naive_version' => $version];
        Cache::put(self::CACHE_KEY, $pin, self::CACHE_TTL_SECONDS);

        return $pin;
    }

    private function readManifestTag(): ?string
    {
        if (! is_file($this->manifestPath) || ! is_readable($this->manifestPath)) {
            Log::warning('naive.pin.manifest_missing', ['path' => $this->manifestPath]);

            return null;
        }
        $raw = @file_get_contents($this->manifestPath);
        if ($raw === false) {
            return null;
        }
        try {
            $parsed = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            Log::warning('naive.pin.manifest_malformed', ['err' => $e->getMessage()]);

            return null;
        }
        if (! is_array($parsed) || ! isset($parsed['upstream_tag']) || ! is_string($parsed['upstream_tag'])) {
            return null;
        }
        $tag = $parsed['upstream_tag'];
        if (! preg_match('/^v\d/', $tag)) {
            return null;
        }

        return $tag;
    }

    /**
     * Parse `naive --version` output. Upstream prints
     * `naive 148.0.7778.96` — single line, no `v` prefix, no rebuild
     * suffix. Returns the version word or null on any failure.
     */
    private function readBinaryVersion(): ?string
    {
        if (! is_file($this->binaryPath) || ! is_executable($this->binaryPath)) {
            return null;
        }
        try {
            $proc = new Process([$this->binaryPath, '--version']);
            $proc->setTimeout(5);
            $proc->run();
        } catch (ProcessRuntimeException $e) {
            Log::warning('naive.pin.exec_failed', ['err' => $e->getMessage()]);

            return null;
        }
        if (! $proc->isSuccessful()) {
            return null;
        }
        $out = trim($proc->getOutput());
        if (! preg_match('/^naive\s+(\S+)/', $out, $m)) {
            return null;
        }

        return $m[1];
    }

    public static function parseVersionOutput(string $out): ?string
    {
        if (preg_match('/^naive\s+(\S+)/', trim($out), $m)) {
            return $m[1];
        }

        return null;
    }
}
