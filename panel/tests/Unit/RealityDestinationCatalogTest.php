<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Unit;

use App\Support\RealityDestinationCatalog;
use Illuminate\Support\Facades\Cache;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

final class RealityDestinationCatalogTest extends TestCase
{
    protected function tearDown(): void
    {
        RealityDestinationCatalog::useLatencyProbeForTests(null);
        Cache::flush();

        parent::tearDown();
    }

    #[Test]
    public function curated_destinations_include_major_cover_sites_and_default(): void
    {
        foreach ([
            RealityDestinationCatalog::DEFAULT_HOST,
            'www.apple.com',
            'www.bing.com',
            'www.cloudflare.com',
            'www.google.com',
            'www.github.com',
            'www.microsoft.com',
            'ya.ru',
        ] as $host) {
            $this->assertContains($host, RealityDestinationCatalog::hostnames());
        }
    }

    #[Test]
    public function labels_can_carry_latency_without_network_probe(): void
    {
        $this->assertSame(
            'Yandex (ya.ru) - RU/EU edge - 42 ms',
            RealityDestinationCatalog::displayLabel('ya.ru', 42),
        );
    }

    #[Test]
    public function host_normalization_accepts_pasted_urls(): void
    {
        $this->assertSame('ya.ru', RealityDestinationCatalog::normalizeHost('https://Ya.Ru/some/path'));
        $this->assertTrue(RealityDestinationCatalog::isSelectableHost('ya.ru'));
        $this->assertFalse(RealityDestinationCatalog::isSelectableHost('not in list.example'));
        $this->assertTrue(RealityDestinationCatalog::isValidHost('WWW.MICROSOFT.COM'));
        $this->assertFalse(RealityDestinationCatalog::isValidHost('https://'));
        $this->assertFalse(RealityDestinationCatalog::isValidHost('localhost'));
    }

    #[Test]
    public function options_can_include_the_current_custom_host(): void
    {
        $options = RealityDestinationCatalog::selectOptions('cover.example.com', measureLatency: false);

        $this->assertArrayHasKey('cover.example.com', $options);
        $this->assertStringContainsString('Current custom', $options['cover.example.com']);
        $this->assertStringNotContainsString('latency', $options['cover.example.com']);
    }

    #[Test]
    public function refreshing_latency_caches_a_snapshot_for_later_display(): void
    {
        RealityDestinationCatalog::useLatencyProbeForTests(fn (string $host): int => $host === 'www.apple.com' ? 24 : 91);

        $snapshot = RealityDestinationCatalog::refreshHostLatency('www.apple.com');

        $this->assertSame(24, $snapshot['latency_ms']);
        $this->assertIsInt($snapshot['checked_at']);

        RealityDestinationCatalog::useLatencyProbeForTests(fn (): int => 999);

        $cached = RealityDestinationCatalog::cachedLatency('www.apple.com');
        $this->assertSame(24, $cached['latency_ms']);
        $this->assertSame($snapshot['checked_at'], $cached['checked_at']);

        $options = RealityDestinationCatalog::selectOptions('www.apple.com', includeCachedLatency: true);
        $this->assertStringContainsString('24 ms', $options['www.apple.com']);
        $this->assertStringContainsString('checked', $options['www.apple.com']);
    }

    #[Test]
    public function latency_summary_reports_unchecked_success_and_failure_states(): void
    {
        $this->assertSame('Latency not checked yet.', RealityDestinationCatalog::latencyStatusText('www.bing.com'));

        RealityDestinationCatalog::useLatencyProbeForTests(fn (): int => 31);
        RealityDestinationCatalog::refreshHostLatency('www.bing.com');
        $this->assertStringContainsString('Last latency: 31 ms at ', RealityDestinationCatalog::latencyStatusText('www.bing.com'));

        RealityDestinationCatalog::useLatencyProbeForTests(fn (): ?int => null);
        RealityDestinationCatalog::refreshHostLatency('www.github.com');
        $this->assertStringContainsString('Last latency check failed at ', RealityDestinationCatalog::latencyStatusText('www.github.com'));
        $this->assertStringContainsString(
            'latency check failed checked',
            RealityDestinationCatalog::selectOptions('www.github.com', includeCachedLatency: true)['www.github.com'],
        );
    }

    #[Test]
    public function refresh_all_latencies_includes_the_current_custom_host(): void
    {
        $probed = [];
        RealityDestinationCatalog::useLatencyProbeForTests(function (string $host) use (&$probed): int {
            $probed[] = $host;

            return $host === 'cover.example.com' ? 77 : 11;
        });

        $results = RealityDestinationCatalog::refreshCatalogLatencies('cover.example.com');

        $this->assertCount(count(RealityDestinationCatalog::hostnames()) + 1, $results);
        $this->assertSame($probed, array_keys($results));
        $this->assertSame(77, RealityDestinationCatalog::cachedLatency('cover.example.com')['latency_ms']);
    }

    #[Test]
    public function warmup_refreshes_catalog_only_when_latency_cache_is_empty(): void
    {
        RealityDestinationCatalog::useLatencyProbeForTests(fn (string $host): int => $host === 'www.apple.com' ? 29 : 13);

        RealityDestinationCatalog::warmCatalogLatenciesIfMissing('www.apple.com');

        $this->assertSame(29, RealityDestinationCatalog::cachedLatency('www.apple.com')['latency_ms']);
        $this->assertSame(13, RealityDestinationCatalog::cachedLatency('www.microsoft.com')['latency_ms']);

        RealityDestinationCatalog::useLatencyProbeForTests(fn (): int => 999);
        RealityDestinationCatalog::warmCatalogLatenciesIfMissing('www.apple.com');

        $this->assertSame(29, RealityDestinationCatalog::cachedLatency('www.apple.com')['latency_ms']);
    }
}
