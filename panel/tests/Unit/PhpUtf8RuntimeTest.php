<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Unit;

use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

class PhpUtf8RuntimeTest extends TestCase
{
    #[Test]
    public function php_runtime_uses_utf8_for_plain_text(): void
    {
        $this->assertSame('UTF-8', ini_get('default_charset'));
        $this->assertSame('UTF-8', mb_internal_encoding());
    }
}
