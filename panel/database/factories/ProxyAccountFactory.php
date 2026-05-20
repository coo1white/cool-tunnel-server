<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Database\Factories;

use App\Models\ProxyAccount;
use App\Support\SingBoxProtocolCatalog;
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
        // The model's $fillable excludes `uuid` (the VLESS credential
        // must be set through regenerateUuid() so callers can never
        // plant an attacker-controlled value). The booted() `creating`
        // hook auto-generates one on save() if none is set, but we
        // pre-seed in afterMaking so factory-built (non-saved)
        // instances still carry a valid UUID for unit tests that
        // serialise them.
        return [
            'username' => 'tu'.Str::random(8),
            'label' => fake()->word(),
            'enabled' => true,
            'client_default_local_port' => 1080,
            'enabled_protocols' => SingBoxProtocolCatalog::defaultKeys(),
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
            // Always have a UUID set so tests that exercise the
            // subscription manifest path don't trip over the missing-
            // credential skip in the renderer.
            $account->regenerateUuid();
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
