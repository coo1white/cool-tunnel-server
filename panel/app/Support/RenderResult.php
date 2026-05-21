<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Support;

final readonly class RenderResult
{
    private function __construct(
        public bool $changed,
        public ?string $hash,
        public bool $failed = false,
    ) {}

    public static function changed(string $hash): self
    {
        if (! preg_match('/^[0-9a-f]{64}$/i', $hash)) {
            throw new \InvalidArgumentException('RenderResult::changed() requires a 64-character SHA-256 hex hash.');
        }

        return new self(true, strtolower($hash));
    }

    public static function unchanged(): self
    {
        return new self(false, null);
    }

    public static function failed(): self
    {
        return new self(false, null, failed: true);
    }
}
