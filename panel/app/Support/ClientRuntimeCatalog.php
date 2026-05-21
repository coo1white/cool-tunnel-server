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

        if (! is_array($decoded) || ! is_array($decoded['plugins'] ?? null)) {
            Log::warning('client_runtime_catalog.invalid_shape');

            return null;
        }

        return $decoded;
    }
}
