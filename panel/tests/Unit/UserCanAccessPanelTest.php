<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Unit;

use App\Models\User;
use Filament\Panel;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Mockery;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// H2 (2026-05-05 audit) gates Filament panel access on three
// independent signals: the panel id matches `admin`, `is_active`
// is true, `role` equals ROLE_ADMIN. Each signal has its own
// failure mode; this test exercises all four cases (one happy +
// three failures) so a future regression that drops one of them
// fails CI loudly.
//
// (v0.0.19 — Loop-5 self-check, closes the test gap on the H2
// fix path identified in the loop-4 audit.)

class UserCanAccessPanelTest extends TestCase
{
    use RefreshDatabase;

    private function adminPanel(): Panel
    {
        $p = Mockery::mock(Panel::class);
        $p->shouldReceive('getId')->andReturn('admin');

        return $p;
    }

    private function viewerPanel(): Panel
    {
        $p = Mockery::mock(Panel::class);
        $p->shouldReceive('getId')->andReturn('viewer');

        return $p;
    }

    #[Test]
    public function active_admin_user_can_access_admin_panel(): void
    {
        $u = User::factory()->create();
        $this->assertTrue($u->canAccessPanel($this->adminPanel()));
    }

    #[Test]
    public function inactive_user_is_denied_even_with_admin_role(): void
    {
        $u = User::factory()->inactive()->create();
        $this->assertFalse($u->canAccessPanel($this->adminPanel()));
    }

    #[Test]
    public function viewer_role_is_denied_admin_panel(): void
    {
        $u = User::factory()->viewer()->create();
        $this->assertFalse($u->canAccessPanel($this->adminPanel()));
    }

    #[Test]
    public function admin_user_is_denied_a_non_admin_panel_id(): void
    {
        $u = User::factory()->create();
        $this->assertFalse($u->canAccessPanel($this->viewerPanel()));
    }

    #[Test]
    public function password_role_is_active_are_not_mass_assignable(): void
    {
        // Defense-in-depth (v0.0.13 H2): privileged fields must
        // never come from $fillable, so a stray
        // User::create($request->all()) cannot promote a viewer
        // to admin or rotate someone else's password.
        $u = User::factory()->create();
        $this->assertNotContains('password', $u->getFillable());
        $this->assertNotContains('role', $u->getFillable());
        $this->assertNotContains('is_active', $u->getFillable());
    }
}
