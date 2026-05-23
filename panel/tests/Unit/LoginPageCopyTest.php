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
    public function login_page_explains_admin_account_and_recovery_command(): void
    {
        $page = new Login;

        $this->assertSame('Log in to Cool Tunnel Server', $page->getHeading());

        $copy = (string) $page->getSubheading();
        $this->assertStringContainsString('holder', $copy);
        $this->assertStringContainsString('cool-tunnel-server-2026', $copy);
        $this->assertStringContainsString('change the password', $copy);
        $this->assertStringContainsString('ct:make-admin --force', $copy);
        $this->assertStringContainsString('you@example.com', $copy);
    }
}
