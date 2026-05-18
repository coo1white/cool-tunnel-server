<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Hash;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// Round-25 admin-auth audit. Pins the four contracts on
// `ct:make-admin` that the audit added to close findings:
//
//   #2  audit log on every privileged admin action
//   #8  re-run on existing email is now SUPPORTED via --force
//       (was: hard-error, no recovery path)
//   #9  --force is the documented lost-password recovery path
//   #10 a UNIQUE-violation race exits cleanly with a hint, not
//       an unhandled QueryException stack trace
//
// The Filament resource pages stay off-limits per convention —
// MakeAdmin is a CLI command (not a page) and is in scope.
class MakeAdminTest extends TestCase
{
    use RefreshDatabase;

    /** @var array<int, array{level:string, message:string, context:array}> */
    private array $logged = [];

    protected function setUp(): void
    {
        parent::setUp();
        $this->logged = [];
        Event::listen(MessageLogged::class, function (MessageLogged $e): void {
            $this->logged[] = ['level' => $e->level, 'message' => $e->message, 'context' => $e->context];
        });
    }

    /** @return array<int, array{level:string, message:string, context:array}> */
    private function loggedMatching(string $needle): array
    {
        return array_values(array_filter($this->logged, fn ($r) => str_contains($r['message'], $needle)));
    }

    #[Test]
    public function fresh_create_succeeds_and_emits_admin_created_log(): void
    {
        $this->artisan('ct:make-admin', [
            '--name' => 'Alice',
            '--email' => 'alice@example.com',
            '--password' => 'correcthorsebatterystaple',
        ])->assertExitCode(0);

        $u = User::where('email', 'alice@example.com')->first();
        $this->assertNotNull($u);
        $this->assertSame('Alice', $u->name);
        $this->assertTrue(Hash::check('correcthorsebatterystaple', $u->password));
        $this->assertTrue($u->is_active);
        $this->assertSame(User::ROLE_ADMIN, $u->role);

        $hits = $this->loggedMatching('admin.created');
        $this->assertCount(1, $hits, 'admin.created must log exactly once');
        $this->assertSame('notice', $hits[0]['level']);
        $this->assertSame('alice@example.com', $hits[0]['context']['email']);
    }

    #[Test]
    public function rerun_without_force_errors_and_does_not_change_password(): void
    {
        $this->artisan('ct:make-admin', [
            '--name' => 'Alice',
            '--email' => 'alice@example.com',
            '--password' => 'firstpassword',
        ])->assertExitCode(0);

        $this->artisan('ct:make-admin', [
            '--name' => 'Alice',
            '--email' => 'alice@example.com',
            '--password' => 'attacker-tries-takeover',
        ])->assertExitCode(1);

        $u = User::where('email', 'alice@example.com')->first();
        $this->assertTrue(Hash::check('firstpassword', $u->password), 'original password must survive a no-force re-run');
        $this->assertFalse(Hash::check('attacker-tries-takeover', $u->password));
    }

    #[Test]
    public function force_resets_password_on_existing_email_and_logs_password_reset(): void
    {
        $this->artisan('ct:make-admin', [
            '--name' => 'Alice',
            '--email' => 'alice@example.com',
            '--password' => 'firstpassword',
        ])->assertExitCode(0);
        $this->logged = []; // clear so the assertions below see only the second run

        $this->artisan('ct:make-admin', [
            '--email' => 'alice@example.com',
            '--password' => 'newpassword',
            '--force' => true,
        ])->assertExitCode(0);

        $u = User::where('email', 'alice@example.com')->first();
        $this->assertTrue(Hash::check('newpassword', $u->password), '--force must reset the password');
        $this->assertFalse(Hash::check('firstpassword', $u->password));

        $hits = $this->loggedMatching('admin.password_reset');
        $this->assertCount(1, $hits);
        $this->assertSame('notice', $hits[0]['level']);
        $this->assertSame('alice@example.com', $hits[0]['context']['email']);

        // No admin.created on the second run.
        $this->assertEmpty($this->loggedMatching('admin.created'));
    }

    #[Test]
    public function force_reenables_a_disabled_demoted_user(): void
    {
        $this->artisan('ct:make-admin', [
            '--name' => 'Alice',
            '--email' => 'alice@example.com',
            '--password' => 'longenoughpw',
        ])->assertExitCode(0);

        // Operator manually demoted + disabled this user via DB or
        // a future admin-management command; --force must restore
        // them so the password-reset path is also a "I locked
        // myself out by accident" recovery path.
        $u = User::where('email', 'alice@example.com')->first();
        $u->role = 'viewer';
        $u->is_active = false;
        $u->save();

        $this->artisan('ct:make-admin', [
            '--email' => 'alice@example.com',
            '--password' => 'newlongpassword',
            '--force' => true,
        ])->assertExitCode(0);

        $u->refresh();
        $this->assertSame(User::ROLE_ADMIN, $u->role);
        $this->assertTrue($u->is_active);
    }

    #[Test]
    public function rejects_short_password(): void
    {
        $this->artisan('ct:make-admin', [
            '--name' => 'Alice',
            '--email' => 'alice@example.com',
            '--password' => 'short',
        ])->assertExitCode(1);
        $this->assertNull(User::where('email', 'alice@example.com')->first());
    }

    #[Test]
    public function rejects_password_wrapped_in_smart_quotes(): void
    {
        $this->artisan('ct:make-admin', [
            '--name' => 'Alice',
            '--email' => 'alice@example.com',
            '--password' => "\u{201C}1234567890\u{201D}",
        ])
            ->expectsOutputToContain('Password contains smart quotes')
            ->assertExitCode(1);

        $this->assertNull(User::where('email', 'alice@example.com')->first());
    }

    #[Test]
    public function accepts_utf8_password_without_smart_quotes(): void
    {
        $password = 'pässwörd-安全-123';

        $this->artisan('ct:make-admin', [
            '--name' => 'Alice',
            '--email' => 'alice@example.com',
            '--password' => $password,
        ])->assertExitCode(0);

        $u = User::where('email', 'alice@example.com')->first();
        $this->assertNotNull($u);
        $this->assertTrue(Hash::check($password, $u->password));
    }

    #[Test]
    public function rejects_invalid_email(): void
    {
        $this->artisan('ct:make-admin', [
            '--name' => 'Alice',
            '--email' => 'not-an-email',
            '--password' => 'longenough',
        ])->assertExitCode(1);
    }
}
