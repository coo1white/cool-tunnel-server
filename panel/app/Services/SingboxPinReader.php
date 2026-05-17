<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Services;

use App\Contracts\SingboxPinReaderInterface;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;

/**
 * Reads the pinned sing-box upstream tag from the panel container's
 * bundled singbox-core binary (docker/panel/Dockerfile bakes
 * /usr/local/bin/singbox-core in the bun-build stage). The value
 * comes from `singbox-core version --json`, which prints:
 *
 *   {"singbox_core":"0.4.0-...","singbox_upstream":"v1.13.12"}
 *
 * — same source of truth as singbox-core/singbox.upstream.json,
 * which is embedded into the binary at Bun-compile time. Reading
 * via `singbox-core version --json` (instead of file_get_contents
 * on the JSON file) means the panel doesn't need to copy the JSON
 * separately — the binary IS the pin.
 *
 * Cached in a process-wide static after the first successful read:
 * the binary is immutable for the lifetime of the container, so
 * re-shelling per request is pure waste. The FrankenPHP worker
 * model keeps the PHP process alive long-term, so this cache is
 * effectively a deploy-lifetime memoise.
 */
final class SingboxPinReader implements SingboxPinReaderInterface
{
    /**
     * Path to the bundled singbox-core binary. Matches the COPY
     * destination in docker/panel/Dockerfile's runtime stage.
     */
    private const BINARY_PATH = '/usr/local/bin/singbox-core';

    /**
     * Bounded so a wedged binary (hang on JSON write, exotic fork
     * stall) cannot stall the subscription endpoint. The happy-path
     * latency is sub-50ms.
     */
    private const TIMEOUT_SEC = 5;

    private ?string $cachedTag = null;

    private bool $cachedFailure = false;

    public function upstreamTag(): ?string
    {
        // Pin reads cluster around panel boot + the first few
        // requests; the negative cache (binary missing) is just as
        // important as the positive one — without it, every
        // subscription request on a misconfigured deploy spawns a
        // sub-process that immediately fails. We cache both
        // outcomes for the worker's lifetime.
        if ($this->cachedTag !== null) {
            return $this->cachedTag;
        }
        if ($this->cachedFailure) {
            return null;
        }

        $tag = $this->readOnce();
        if ($tag === null) {
            $this->cachedFailure = true;

            return null;
        }
        $this->cachedTag = $tag;

        return $tag;
    }

    private function readOnce(): ?string
    {
        $proc = new Process([self::BINARY_PATH, 'version', '--json']);
        $proc->setTimeout(self::TIMEOUT_SEC);
        $proc->setIdleTimeout(self::TIMEOUT_SEC);
        try {
            $proc->run();
        } catch (\Throwable $e) {
            Log::critical('singbox.pin.process_failed', [
                'err' => $e->getMessage(),
                'type' => $e::class,
            ]);

            return null;
        }
        if (! $proc->isSuccessful()) {
            Log::critical('singbox.pin.nonzero_exit', [
                'exit' => $proc->getExitCode(),
                'stderr' => substr(trim($proc->getErrorOutput()), 0, 240),
            ]);

            return null;
        }
        $stdout = trim($proc->getOutput());
        if ($stdout === '') {
            Log::critical('singbox.pin.empty_stdout', []);

            return null;
        }
        $decoded = json_decode($stdout, true);
        if (! is_array($decoded)) {
            Log::critical('singbox.pin.non_json_stdout', [
                'stdout' => substr($stdout, 0, 240),
            ]);

            return null;
        }
        $tag = (string) ($decoded['singbox_upstream'] ?? '');
        if ($tag === '') {
            Log::critical('singbox.pin.missing_upstream_key', [
                'keys' => array_keys($decoded),
            ]);

            return null;
        }

        return $tag;
    }
}
