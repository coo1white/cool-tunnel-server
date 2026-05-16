<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Unit;

use App\Services\NaivePinReader;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

// Pure-logic unit tests for NaivePinReader's parser. The
// shell-out + file-read paths are exercised end-to-end via
// SubscriptionContractTest::server_naive_pin_*; here we only
// pin the version-string parser so a future tweak to upstream's
// `naive --version` output format doesn't silently mis-parse.

class NaivePinReaderTest extends TestCase
{
    #[Test]
    public function parses_naive_version_with_trailing_newline(): void
    {
        $this->assertSame(
            '148.0.7778.96',
            NaivePinReader::parseVersionOutput("naive 148.0.7778.96\n")
        );
    }

    #[Test]
    public function parses_naive_version_without_trailing_newline(): void
    {
        $this->assertSame(
            '148.0.7778.96',
            NaivePinReader::parseVersionOutput('naive 148.0.7778.96')
        );
    }

    #[Test]
    public function parses_naive_version_with_trailing_build_metadata(): void
    {
        $this->assertSame(
            '148.0.7778.96',
            NaivePinReader::parseVersionOutput('naive 148.0.7778.96 (custom build)')
        );
    }

    #[Test]
    public function returns_null_on_unrelated_output(): void
    {
        $this->assertNull(
            NaivePinReader::parseVersionOutput('bash: naive: command not found')
        );
    }

    #[Test]
    public function returns_null_on_empty_output(): void
    {
        $this->assertNull(NaivePinReader::parseVersionOutput(''));
    }
}
