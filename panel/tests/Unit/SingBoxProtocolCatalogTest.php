<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Unit;

use App\Support\SingBoxProtocolCatalog;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

final class SingBoxProtocolCatalogTest extends TestCase
{
    #[Test]
    public function normalize_selected_accepts_filament_boolean_maps(): void
    {
        $this->assertSame(
            ['vless_reality'],
            SingBoxProtocolCatalog::normalizeSelected([
                'vless_reality' => true,
                'shadowsocks' => false,
                'tor' => true,
            ]),
        );
        $this->assertSame(
            [],
            SingBoxProtocolCatalog::normalizeSelected(['tor' => true]),
            'Rows that only contain retired modes must not silently gain VLESS access.',
        );
    }

    #[Test]
    public function unknown_keys_are_reported_before_normalization_drops_them(): void
    {
        $this->assertSame(
            ['shadowsocks', 'definitely-not-singbox'],
            SingBoxProtocolCatalog::invalidKeys(['vless_reality', 'shadowsocks', 'definitely-not-singbox']),
        );
    }

    #[Test]
    public function empty_submitted_form_state_can_skip_the_legacy_default(): void
    {
        $this->assertSame([], SingBoxProtocolCatalog::normalizeSelected([], defaultWhenEmpty: false));
    }

    #[Test]
    public function normalize_selected_deduplicates_while_preserving_order(): void
    {
        $this->assertSame(
            ['vless_reality'],
            SingBoxProtocolCatalog::normalizeSelected([
                'vless_reality',
                'VLESS_REALITY',
                'shadowsocks',
                'vless_reality',
            ]),
        );
    }

    #[Test]
    public function mode_summary_reports_only_core_protocol_state(): void
    {
        $this->assertSame(
            'VLESS + Reality active',
            SingBoxProtocolCatalog::modeSummary(['vless_reality', 'hysteria2', 'tor']),
        );
        $this->assertSame(
            'No active core mode',
            SingBoxProtocolCatalog::modeSummary(['hysteria2', 'tor']),
        );
    }
}
