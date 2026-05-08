<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Command;
use Illuminate\Database\QueryException;
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
    protected $signature = 'ct:make-admin
                            {--name= : Display name (prompts if omitted; ignored on --force update of existing user)}
                            {--email= : Email address (prompts if omitted)}
                            {--password= : Cleartext password (prompts if omitted; never logged)}
                            {--force : Reset password on an existing email instead of erroring (docs as the recover-from-lost-password path)}';

    protected $description = 'Create a Filament admin user, or reset an existing admin\'s password with --force';

    public function handle(): int
    {
        $force = (bool) $this->option('force');
        $name = $this->option('name') ?: ($force ? '' : $this->ask('Name'));
        $email = $this->option('email') ?: $this->ask('Email address');
        $password = $this->option('password') ?: $this->secret('Password');

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
}
