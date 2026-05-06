<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Command;
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

class MakeAdmin extends Command
{
    protected $signature = 'ct:make-admin
                            {--name= : Display name (prompts if omitted)}
                            {--email= : Email address (prompts if omitted)}
                            {--password= : Cleartext password (prompts if omitted; never logged)}';

    protected $description = 'Create a Filament admin user (respects User-model fillable hardening)';

    public function handle(): int
    {
        $name = $this->option('name') ?: $this->ask('Name');
        $email = $this->option('email') ?: $this->ask('Email address');
        $password = $this->option('password') ?: $this->secret('Password');

        $validator = Validator::make(
            ['name' => $name, 'email' => $email, 'password' => $password],
            [
                'name' => ['required', 'string', 'max:255'],
                'email' => ['required', 'email:rfc'],
                'password' => ['required', 'string', 'min:8'],
            ]
        );
        if ($validator->fails()) {
            foreach ($validator->errors()->all() as $msg) {
                $this->error($msg);
            }
            return self::FAILURE;
        }

        if (User::query()->where('email', $email)->exists()) {
            $this->error("user with email {$email} already exists");
            return self::FAILURE;
        }

        // Leave $email_verified_at null. canAccessPanel() doesn't
        // enforce verification (Cool Tunnel ships no SMTP); setting
        // it would imply a verification step that didn't happen.
        $user = new User();
        $user->name = $name;
        $user->email = $email;
        $user->password = $password;     // 'hashed' cast applies on assign
        $user->role = User::ROLE_ADMIN;
        $user->is_active = true;
        $user->save();

        $this->info("admin created: {$email} (role=admin, is_active=true)");

        return self::SUCCESS;
    }
}
