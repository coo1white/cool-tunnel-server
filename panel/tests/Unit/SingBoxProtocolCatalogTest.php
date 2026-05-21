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
    public function normalise_selected_accepts_filament_boolean_maps(): void
    {
        $this->assertSame(
            ['vless_reality'],
            SingBoxProtocolCatalog::normaliseSelected([
                'vless_reality' => true,
                'shadowsocks' => false,
                'tor' => true,
            ]),
        );
        $this->assertSame(
            [],
            SingBoxProtocolCatalog::normaliseSelected(['tor' => true]),
            'Rows that only contain retired modes must not silently gain VLESS access.',
        );
    }

    #[Test]
    public function unknown_keys_are_reported_before_normalisation_drops_them(): void
    {
        $this->assertSame(
            ['shadowsocks', 'definitely-not-singbox'],
            SingBoxProtocolCatalog::invalidKeys(['vless_reality', 'shadowsocks', 'definitely-not-singbox']),
        );
    }

    #[Test]
    public function empty_submitted_form_state_can_skip_the_legacy_default(): void
    {
        $this->assertSame([], SingBoxProtocolCatalog::normaliseSelected([], defaultWhenEmpty: false));
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
