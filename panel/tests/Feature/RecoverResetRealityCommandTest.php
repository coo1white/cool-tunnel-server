<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\ServerConfig;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Process;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

final class RecoverResetRealityCommandTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function reset_reality_rotates_only_the_reality_keypair(): void
    {
        Process::fake([
            '*' => Process::result(json_encode([
                'private_key' => 'new-private',
                'public_key' => 'new-public',
            ], JSON_THROW_ON_ERROR)),
        ]);

        $cfg = ServerConfig::factory()->create([
            'domain' => 'proxy.example.com',
            'reality_private_key' => 'old-private',
            'reality_public_key' => 'old-public',
            'reality_short_ids' => ['abc123'],
        ]);

        $this->artisan('recover:reset-reality')
            ->expectsOutput('new Reality keypair generated')
            ->expectsOutput('Clients must re-import subscription URLs.')
            ->assertSuccessful();

        $fresh = $cfg->fresh();

        $this->assertSame('proxy.example.com', $fresh->domain);
        $this->assertSame([''], $fresh->reality_short_ids);
        $this->assertSame('new-private', $fresh->reality_private_key);
        $this->assertSame('new-public', $fresh->reality_public_key);
    }
}
