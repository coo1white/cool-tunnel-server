<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Unit;

use App\Filament\Pages\Auth\Login;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

class LoginPageCopyTest extends TestCase
{
    #[Test]
    public function login_page_does_not_expose_bootstrap_credentials_or_recovery_commands(): void
    {
        $page = new Login;

        $this->assertSame('Log in to Cool Tunnel Server', $page->getHeading());

        $copy = (string) ($page->getSubheading() ?? '');
        $this->assertSame('', $copy);
        $this->assertStringNotContainsString('holder', $copy);
        $this->assertStringNotContainsString('cool-tunnel-server-2026', $copy);
        $this->assertStringNotContainsString('ct:make-admin', $copy);
        $this->assertStringNotContainsString('docker compose', $copy);
        $this->assertStringNotContainsString('you@example.com', $copy);
    }
}
