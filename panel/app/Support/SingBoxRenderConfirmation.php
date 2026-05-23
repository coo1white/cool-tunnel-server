<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Support;

use App\Contracts\SingBoxConfigGeneratorInterface;
use Illuminate\Support\Facades\Log;
use Throwable;

final class SingBoxRenderConfirmation
{
    private const CONFIG_PATH = '/data/config/singbox.json';

    public static function renderNow(string $context): bool
    {
        try {
            $result = app(SingBoxConfigGeneratorInterface::class)->renderToFile();
            if (! $result->failed) {
                self::nudgeConfigMtime($context);
            }

            return ! $result->failed;
        } catch (Throwable $e) {
            Log::warning("{$context}.immediate_render_failed", [
                'err' => $e->getMessage(),
                'type' => $e::class,
            ]);

            return false;
        }
    }

    private static function nudgeConfigMtime(string $context): void
    {
        if (! is_file(self::CONFIG_PATH)) {
            return;
        }

        if (@touch(self::CONFIG_PATH) !== true) {
            Log::warning("{$context}.config_mtime_nudge_failed", [
                'path' => self::CONFIG_PATH,
            ]);
        }
    }
}
