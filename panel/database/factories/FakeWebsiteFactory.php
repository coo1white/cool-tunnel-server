<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Database\Factories;

use App\Models\FakeWebsite;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<FakeWebsite>
 */
class FakeWebsiteFactory extends Factory
{
    protected $model = FakeWebsite::class;

    public function definition(): array
    {
        return [
            'slug' => 'fs-'.Str::random(8),
            'name' => fake()->company(),
            'template' => 'blog',
            'title' => fake()->sentence(3),
            'tagline' => fake()->sentence(6),
            'payload' => null,
            'is_active' => false,
        ];
    }

    public function active(): static
    {
        return $this->state(fn () => ['is_active' => true]);
    }
}
