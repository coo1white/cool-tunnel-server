<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\ProxyAccount;
use App\Models\ServerConfig;
use App\Services\SingBoxConfigGenerator;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use ReflectionClass;
use Tests\TestCase;

final class PreviousUuidGraceRenderTest extends TestCase
{
    use RefreshDatabase;

    /** @return array<string,mixed> */
    private function renderInput(): array
    {
        $method = (new ReflectionClass(SingBoxConfigGenerator::class))->getMethod('buildRenderInput');
        $input = $method->invoke(app(SingBoxConfigGenerator::class));
        $this->assertIsArray($input);

        return $input;
    }

    #[Test]
    public function render_input_includes_previous_uuid_during_regeneration_grace_window(): void
    {
        ServerConfig::factory()->create();
        $account = ProxyAccount::factory()->create(['username' => 'test1']);
        $oldUuid = (string) $account->uuid;

        $account->regenerateUuid();
        $account->save();
        $newUuid = (string) $account->uuid;

        $accounts = collect($this->renderInput()['accounts']);

        $this->assertTrue($accounts->contains(fn (array $entry): bool => $entry['username'] === 'test1'
            && $entry['uuid'] === $newUuid));
        $this->assertTrue($accounts->contains(fn (array $entry): bool => $entry['username'] === "__previous_uuid:{$account->id}:test1"
            && $entry['uuid'] === $oldUuid));
    }

    #[Test]
    public function render_input_omits_previous_uuid_after_grace_window_expires(): void
    {
        ServerConfig::factory()->create();
        $account = ProxyAccount::factory()->create(['username' => 'test1']);
        $oldUuid = (string) $account->uuid;

        $account->regenerateUuid();
        $account->previous_uuid_valid_until = now()->subSecond();
        $account->save();

        $accounts = collect($this->renderInput()['accounts']);

        $this->assertFalse($accounts->contains(fn (array $entry): bool => $entry['uuid'] === $oldUuid));
        $this->assertFalse($accounts->contains(fn (array $entry): bool => str_starts_with($entry['username'], '__previous_uuid:')));
    }
}
