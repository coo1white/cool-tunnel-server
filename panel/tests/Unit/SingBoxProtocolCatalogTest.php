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
            ['vless_reality', 'tor'],
            SingBoxProtocolCatalog::normaliseSelected([
                'vless_reality' => true,
                'shadowsocks' => false,
                'tor' => true,
            ]),
        );
    }

    #[Test]
    public function unknown_keys_are_reported_before_normalisation_drops_them(): void
    {
        $this->assertSame(
            ['definitely-not-singbox'],
            SingBoxProtocolCatalog::invalidKeys(['vless_reality', 'definitely-not-singbox']),
        );
    }

    #[Test]
    public function empty_submitted_form_state_can_skip_the_legacy_default(): void
    {
        $this->assertSame([], SingBoxProtocolCatalog::normaliseSelected([], defaultWhenEmpty: false));
    }

    #[Test]
    public function mode_summary_separates_active_and_staged_protocols(): void
    {
        $this->assertSame(
            'VLESS + Reality active; Hysteria2, Tor staged',
            SingBoxProtocolCatalog::modeSummary(['vless_reality', 'hysteria2', 'tor']),
        );
    }
}
