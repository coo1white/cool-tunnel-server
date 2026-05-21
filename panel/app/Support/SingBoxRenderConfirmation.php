<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Support;

use App\Contracts\SingBoxConfigGeneratorInterface;
use Illuminate\Support\Facades\Log;
use Throwable;

final class SingBoxRenderConfirmation
{
    public static function renderNow(string $context): bool
    {
        try {
            $result = app(SingBoxConfigGeneratorInterface::class)->renderToFile();

            return ! $result->failed;
        } catch (Throwable $e) {
            Log::warning("{$context}.immediate_render_failed", [
                'err' => $e->getMessage(),
                'type' => $e::class,
            ]);

            return false;
        }
    }
}
