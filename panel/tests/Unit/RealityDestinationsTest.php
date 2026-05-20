<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Unit;

use App\Support\RealityDestinations;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class RealityDestinationsTest extends TestCase
{
    #[Test]
    public function curated_destinations_include_yandex_and_default(): void
    {
        $this->assertContains('ya.ru', RealityDestinations::hosts());
        $this->assertContains(RealityDestinations::DEFAULT_HOST, RealityDestinations::hosts());
    }

    #[Test]
    public function labels_can_carry_latency_without_network_probe(): void
    {
        $this->assertSame(
            'Yandex (ya.ru) - RU/EU edge - 42 ms',
            RealityDestinations::label('ya.ru', 42),
        );
    }

    #[Test]
    public function host_normalisation_accepts_pasted_urls(): void
    {
        $this->assertSame('ya.ru', RealityDestinations::normaliseHost('https://Ya.Ru/some/path'));
        $this->assertTrue(RealityDestinations::isSelectableHost('ya.ru'));
        $this->assertFalse(RealityDestinations::isSelectableHost('not in list.example'));
        $this->assertTrue(RealityDestinations::isValidHost('WWW.MICROSOFT.COM'));
        $this->assertFalse(RealityDestinations::isValidHost('https://'));
        $this->assertFalse(RealityDestinations::isValidHost('localhost'));
    }

    #[Test]
    public function options_can_include_the_current_custom_host(): void
    {
        $options = RealityDestinations::options('cover.example.com', measureLatency: false);

        $this->assertArrayHasKey('cover.example.com', $options);
        $this->assertStringContainsString('Current custom', $options['cover.example.com']);
    }
}
