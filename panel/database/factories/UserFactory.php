<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Database\Factories;

use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<User>
 */
class UserFactory extends Factory
{
    protected $model = User::class;

    public function definition(): array
    {
        return [
            'name' => fake()->name(),
            'email' => fake()->unique()->safeEmail(),
            'email_verified_at' => now(),
            'password' => 'password',  // hashed by the User model's $casts['password']
            'role' => User::ROLE_ADMIN,
            'is_active' => true,
            'must_change_password' => false,
            'remember_token' => Str::random(10),
        ];
    }

    /** Build a row that should fail canAccessPanel. */
    public function viewer(): static
    {
        return $this->state(fn () => ['role' => User::ROLE_VIEWER]);
    }

    public function inactive(): static
    {
        return $this->state(fn () => ['is_active' => false]);
    }

    public function mustChangePassword(): static
    {
        return $this->state(fn () => ['must_change_password' => true]);
    }
}
