<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Database\Factories;

use App\Models\ProxyAccount;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<ProxyAccount>
 */
class ProxyAccountFactory extends Factory
{
    protected $model = ProxyAccount::class;

    public function definition(): array
    {
        // The model's $fillable excludes password_hash and
        // password_cleartext_encrypted (H2 hardening). Use
        // afterMaking + setCleartextPassword to populate them
        // through the right channel.
        return [
            'username' => 'tu'.Str::random(8),
            'label' => fake()->word(),
            'enabled' => true,
            'quota_bytes' => null,
            'used_bytes' => 0,
            'expires_at' => null,
            'last_seen_at' => null,
            'metadata' => null,
        ];
    }

    public function configure(): static
    {
        return $this->afterMaking(function (ProxyAccount $account) {
            // Always have a cleartext password set so tests that
            // exercise the subscription manifest path don't trip
            // over the cleartext-missing-skip in the renderer.
            $account->setCleartextPassword('test-password-'.Str::random(12));
        });
    }

    public function expired(): static
    {
        return $this->state(fn () => [
            'expires_at' => now()->subDay(),
        ]);
    }

    public function disabled(): static
    {
        return $this->state(fn () => [
            'enabled' => false,
        ]);
    }
}
