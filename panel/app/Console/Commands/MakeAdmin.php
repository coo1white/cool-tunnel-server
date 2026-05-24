<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Command;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Validator;

// Project-specific admin creator. Replaces Filament's stock
// `make:filament-user` because the User model deliberately drops
// `password`, `role`, and `is_active` from $fillable (audit H3) —
// the stock command's `User::create([...])` silently strips
// `password` from the insert, which then fails with
// "Field 'password' doesn't have a default value".
//
// This command bypasses mass assignment and writes the privileged
// fields by direct property access. The 'hashed' cast on
// User::$casts hashes the cleartext password on assignment.
//
// `role` and `is_active` are set explicitly here even though the
// `add_role_and_active_to_users` migration provides DB-level
// defaults — relying on DB defaults works for the singleton
// first-admin case, but writing the values out makes the command
// self-documenting about the security state of rows it creates.
//
// Round-25 admin-auth audit hardenings:
//
//   - `--force`: when set, an existing email RESETS the password
//     instead of erroring. Previously the command refused to act
//     on an existing email, leaving a forgotten-password operator
//     with only the "raw DB UPDATE" path. With `--force`, the same
//     `ct:make-admin --force --email=...` is the documented
//     password-reset workflow. Re-promotes role to admin + flips
//     is_active back to true so a previously-disabled-and-demoted
//     account can be recovered too.
//   - Structured `Log::notice('admin.created'|'admin.password_reset',
//     [email])` on success — closes the round-12 observability gap
//     for privileged actions. Email is in the log; cleartext is
//     NEVER logged.
//   - QueryException caught around save() with a friendly message —
//     two operators racing on a fresh DB used to crash with an
//     unhandled UNIQUE-constraint exception; now exits cleanly with
//     a "the other operator won, re-run with --force to update"
//     pointer.

class MakeAdmin extends Command
{
    public const DEFAULT_NAME = 'holder';

    public const DEFAULT_EMAIL = 'holder@cool-tunnel.local';

    private const LEGACY_PUBLIC_DEFAULT_PASSWORD = 'cool-tunnel-server-2026';

    private const SMART_QUOTE_PATTERN = '/[\x{2018}\x{2019}\x{201A}\x{201B}\x{201C}\x{201D}\x{201E}\x{201F}]/u';

    protected $signature = 'ct:make-admin
                            {--name= : Display name (prompts if omitted; ignored on --force update of existing user)}
                            {--email= : Email address (prompts if omitted)}
                            {--password= : Cleartext password (prompts if omitted; never logged)}
                            {--bootstrap-default : Idempotently create the first default admin login (holder; password from --password or CT_BOOTSTRAP_ADMIN_PASSWORD)}
                            {--force : Reset password on an existing email instead of erroring (docs as the recover-from-lost-password path)}';

    protected $description = 'Create a Filament admin user, or reset an existing admin\'s password with --force';

    public function handle(): int
    {
        if ((bool) $this->option('bootstrap-default')) {
            return $this->bootstrapDefaultAdmin();
        }

        $force = (bool) $this->option('force');
        $name = $this->option('name') ?: ($force ? '' : $this->ask('Name'));
        $email = $this->option('email') ?: $this->ask('Email address');
        $password = $this->option('password') ?: $this->secret('Password');

        if (self::containsSmartQuote((string) $password)) {
            $this->error('Password contains smart quotes. UTF-8 passwords are supported, but smart quotes are usually pasted shell delimiters; re-run with straight shell quotes or no quotes around simple passwords.');

            return self::FAILURE;
        }

        // On --force update, name is optional (we don't overwrite
        // the existing display name unless explicitly given).
        $rules = [
            'email' => ['required', 'email:rfc'],
            'password' => ['required', 'string', 'min:8'],
        ];
        if (! $force || $name !== '') {
            $rules['name'] = ['required', 'string', 'max:255'];
        }
        $validator = Validator::make(
            ['name' => $name, 'email' => $email, 'password' => $password],
            $rules,
        );
        if ($validator->fails()) {
            foreach ($validator->errors()->all() as $msg) {
                $this->error($msg);
            }

            return self::FAILURE;
        }

        $existing = User::query()->where('email', $email)->first();
        if ($existing !== null && ! $force) {
            $this->error("user with email {$email} already exists");
            $this->line('  → re-run with --force to RESET the password (recover-from-lost-password path)');

            return self::FAILURE;
        }

        try {
            if ($existing !== null) {
                $existing->password = $password;     // 'hashed' cast hashes on assign
                $existing->role = User::ROLE_ADMIN;  // re-promote if previously demoted
                $existing->is_active = true;         // re-enable if previously disabled
                $existing->must_change_password = false;
                if ($name !== '') {
                    $existing->name = $name;         // optional rename
                }
                $existing->save();
                Log::notice('admin.password_reset', ['email' => $email]);
                $this->info("admin password reset: {$email} (role=admin, is_active=true)");

                return self::SUCCESS;
            }

            // Leave $email_verified_at null. canAccessPanel() doesn't
            // enforce verification (Cool Tunnel ships no SMTP); setting
            // it would imply a verification step that didn't happen.
            $user = new User;
            $user->name = $name;
            $user->email = $email;
            $user->password = $password;     // 'hashed' cast applies on assign
            $user->role = User::ROLE_ADMIN;
            $user->is_active = true;
            $user->must_change_password = false;
            $user->save();
            Log::notice('admin.created', ['email' => $email]);
            $this->info("admin created: {$email} (role=admin, is_active=true)");

            return self::SUCCESS;
        } catch (QueryException $e) {
            // Two operators racing `ct:make-admin` on a fresh DB —
            // one wins the UNIQUE-on-email constraint, the other
            // lands here. Pre-fix this surfaced as an unhandled
            // SQLSTATE[23000] stack trace; now it's a clean exit
            // with the recovery hint.
            $this->error("could not create/update admin {$email}: {$e->getMessage()}");
            $this->line('  → if another operator just created this user, re-run with --force to take over the password');

            return self::FAILURE;
        }
    }

    private static function containsSmartQuote(string $value): bool
    {
        return preg_match(self::SMART_QUOTE_PATTERN, $value) === 1;
    }

    private function bootstrapDefaultAdmin(): int
    {
        $adminCount = User::query()
            ->where('role', User::ROLE_ADMIN)
            ->where('is_active', true)
            ->count();

        $password = $this->validatedBootstrapPassword();
        if ($password === null) {
            return self::FAILURE;
        }

        $existing = User::query()->where('email', self::DEFAULT_EMAIL)->first();
        if ($existing !== null) {
            if (Hash::check(self::LEGACY_PUBLIC_DEFAULT_PASSWORD, (string) $existing->password)) {
                $existing->password = $password;
                $existing->role = User::ROLE_ADMIN;
                $existing->is_active = true;
                $existing->must_change_password = true;
                $existing->save();

                Log::notice('admin.default_rotated_from_legacy_public_password', ['email' => self::DEFAULT_EMAIL]);
                $this->info('default admin rotated to CT_BOOTSTRAP_ADMIN_PASSWORD: holder (must_change_password=true)');

                return self::SUCCESS;
            }

            $this->info('default admin already present: holder');

            return self::SUCCESS;
        }

        if ($adminCount > 0) {
            $this->info('active admin already exists; not creating default admin');

            return self::SUCCESS;
        }

        $user = new User;
        $user->name = self::DEFAULT_NAME;
        $user->email = self::DEFAULT_EMAIL;
        $user->password = $password;
        $user->role = User::ROLE_ADMIN;
        $user->is_active = true;
        $user->must_change_password = true;
        $user->save();

        Log::notice('admin.default_created', ['email' => self::DEFAULT_EMAIL]);
        $this->info('default admin created: holder (must_change_password=true)');

        return self::SUCCESS;
    }

    private function validatedBootstrapPassword(): ?string
    {
        $password = (string) ($this->option('password') ?: config('cool-tunnel.bootstrap_admin_password', ''));
        if ($password === '') {
            $this->error('Bootstrap admin password missing. Pass --password or set CT_BOOTSTRAP_ADMIN_PASSWORD in .env.');

            return null;
        }
        if (self::containsSmartQuote($password)) {
            $this->error('Bootstrap admin password contains smart quotes. Re-run with straight shell quotes or regenerate CT_BOOTSTRAP_ADMIN_PASSWORD.');

            return null;
        }
        $validator = Validator::make(
            ['password' => $password],
            ['password' => ['required', 'string', 'min:8']],
        );
        if ($validator->fails()) {
            foreach ($validator->errors()->all() as $msg) {
                $this->error($msg);
            }

            return null;
        }

        return $password;
    }
}
