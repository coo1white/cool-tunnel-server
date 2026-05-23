<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Console\Commands\MakeAdmin;
use App\Filament\Pages\Auth\EditProfile;
use App\Filament\Pages\Auth\Login;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Livewire\Livewire;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

final class InitialAdminPasswordChangeTest extends TestCase
{
    use RefreshDatabase;

    private const BOOTSTRAP_PASSWORD = 'local-bootstrap-password-2026';

    #[Test]
    public function bootstrap_default_admin_is_idempotent_and_requires_password_change(): void
    {
        $this->artisan('ct:make-admin', [
            '--bootstrap-default' => true,
            '--password' => self::BOOTSTRAP_PASSWORD,
        ])
            ->expectsOutputToContain('default admin created')
            ->assertExitCode(0);

        $user = User::where('name', MakeAdmin::DEFAULT_NAME)->first();
        $this->assertNotNull($user);
        $this->assertSame(MakeAdmin::DEFAULT_EMAIL, $user->email);
        $this->assertTrue(Hash::check(self::BOOTSTRAP_PASSWORD, $user->password));
        $this->assertTrue($user->is_active);
        $this->assertSame(User::ROLE_ADMIN, $user->role);
        $this->assertTrue($user->must_change_password);

        $this->artisan('ct:make-admin', [
            '--bootstrap-default' => true,
            '--password' => self::BOOTSTRAP_PASSWORD,
        ])
            ->expectsOutputToContain('default admin already present')
            ->assertExitCode(0);

        $this->assertSame(1, User::count());
    }

    #[Test]
    public function bootstrap_default_admin_rotates_legacy_public_password(): void
    {
        $user = User::factory()->create([
            'name' => MakeAdmin::DEFAULT_NAME,
            'email' => MakeAdmin::DEFAULT_EMAIL,
            'password' => 'cool-tunnel-server-2026',
            'role' => User::ROLE_ADMIN,
            'is_active' => true,
            'must_change_password' => false,
        ]);

        $this->artisan('ct:make-admin', [
            '--bootstrap-default' => true,
            '--password' => self::BOOTSTRAP_PASSWORD,
        ])
            ->expectsOutputToContain('default admin rotated to CT_BOOTSTRAP_ADMIN_PASSWORD')
            ->assertExitCode(0);

        $user->refresh();
        $this->assertTrue(Hash::check(self::BOOTSTRAP_PASSWORD, $user->password));
        $this->assertFalse(Hash::check('cool-tunnel-server-2026', $user->password));
        $this->assertSame(User::ROLE_ADMIN, $user->role);
        $this->assertTrue($user->is_active);
        $this->assertTrue($user->must_change_password);
    }

    #[Test]
    public function bootstrap_default_admin_does_not_recreate_known_password_when_an_admin_exists(): void
    {
        User::factory()->create(['email' => 'real-admin@example.com']);

        $this->artisan('ct:make-admin', [
            '--bootstrap-default' => true,
            '--password' => self::BOOTSTRAP_PASSWORD,
        ])
            ->expectsOutputToContain('active admin already exists')
            ->assertExitCode(0);

        $this->assertNull(User::where('email', MakeAdmin::DEFAULT_EMAIL)->first());
        $this->assertSame(1, User::count());
    }

    #[Test]
    public function login_accepts_default_admin_name_and_existing_admin_email(): void
    {
        $this->artisan('ct:make-admin', [
            '--bootstrap-default' => true,
            '--password' => self::BOOTSTRAP_PASSWORD,
        ])->assertExitCode(0);

        Livewire::test(Login::class)
            ->fillForm([
                'email' => MakeAdmin::DEFAULT_NAME,
                'password' => self::BOOTSTRAP_PASSWORD,
            ])
            ->call('authenticate')
            ->assertHasNoFormErrors();

        $this->assertAuthenticated();

        auth()->logout();

        User::factory()->create([
            'email' => 'alice@example.com',
            'password' => 'long-enough-password',
        ]);

        Livewire::test(Login::class)
            ->fillForm([
                'email' => 'alice@example.com',
                'password' => 'long-enough-password',
            ])
            ->call('authenticate')
            ->assertHasNoFormErrors();

        $this->assertAuthenticated();
    }

    #[Test]
    public function forced_admin_is_redirected_to_profile_until_password_changes(): void
    {
        $admin = User::factory()->mustChangePassword()->create();

        $this->actingAs($admin)
            ->get('/admin')
            ->assertRedirect('/admin/profile');

        $this->actingAs($admin)
            ->get('/admin/profile')
            ->assertOk();
    }

    #[Test]
    public function changing_password_clears_force_change_flag_and_replaces_default_password(): void
    {
        $this->artisan('ct:make-admin', [
            '--bootstrap-default' => true,
            '--password' => self::BOOTSTRAP_PASSWORD,
        ])->assertExitCode(0);
        $admin = User::where('email', MakeAdmin::DEFAULT_EMAIL)->firstOrFail();

        Livewire::actingAs($admin);
        Livewire::test(EditProfile::class)
            ->fillForm([
                'name' => MakeAdmin::DEFAULT_NAME,
                'email' => MakeAdmin::DEFAULT_EMAIL,
                'password' => 'new-cool-tunnel-password-2026',
                'passwordConfirmation' => 'new-cool-tunnel-password-2026',
            ])
            ->call('save')
            ->assertHasNoFormErrors();

        $admin->refresh();
        $this->assertFalse($admin->must_change_password);
        $this->assertFalse(Hash::check(self::BOOTSTRAP_PASSWORD, $admin->password));
        $this->assertTrue(Hash::check('new-cool-tunnel-password-2026', $admin->password));
    }
}
