<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Contracts\SingBoxConfigGeneratorInterface;
use App\Filament\Resources\ProxyAccountResource\Pages\CreateProxyAccount;
use App\Filament\Resources\ProxyAccountResource\Pages\EditProxyAccount;
use App\Filament\Resources\ProxyAccountResource\Pages\ListProxyAccounts;
use App\Models\ProxyAccount;
use App\Models\ServerConfig;
use App\Models\User;
use Filament\Notifications\Notification;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Livewire\Livewire;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

final class ProxyAccountFilamentResourceTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function list_shows_core_protocol_mode_without_noisy_columns(): void
    {
        $admin = User::factory()->create();
        $account = ProxyAccount::factory()->create([
            'username' => 'test2',
            'label' => 'Home laptop',
        ]);

        Livewire::actingAs($admin)
            ->test(ListProxyAccounts::class)
            ->assertCanRenderTableColumn('protocol_mode')
            ->assertTableColumnStateSet('protocol_mode', 'VLESS + Reality active', $account)
            ->assertTableColumnHasDescription('username', 'Home laptop', $account)
            ->assertTableColumnDoesNotExist('label')
            ->assertTableColumnDoesNotExist('used_bytes')
            ->assertTableColumnDoesNotExist('quota_bytes');
    }

    #[Test]
    public function edit_form_presents_mode_as_read_only_core_state(): void
    {
        $admin = User::factory()->create();
        $account = ProxyAccount::factory()->create([
            'enabled_protocols' => ['vless_reality', 'hysteria2'],
        ]);

        Livewire::actingAs($admin)
            ->test(EditProxyAccount::class, ['record' => $account->getKey()])
            ->assertFormComponentExists('protocol_mode')
            ->assertFormComponentDoesNotExist('enabled_protocols')
            ->assertSeeText('VLESS + Reality active; Hysteria2 staged');
    }

    #[Test]
    public function create_form_creates_core_account_without_rotating_reality_destination(): void
    {
        $admin = User::factory()->create();
        ServerConfig::factory()->create(['reality_dest_host' => 'ya.ru']);
        $generator = new ProxyAccountResourceFakeSingBoxGenerator(str_repeat('a', 64));
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $generator);

        Livewire::actingAs($admin)
            ->test(CreateProxyAccount::class)
            ->assertFormComponentExists('protocol_mode')
            ->assertFormComponentDoesNotExist('enabled_protocols')
            ->assertFormComponentDoesNotExist('reality_dest_host')
            ->assertSeeText('VLESS + Reality active')
            ->fillForm([
                'username' => 'test2',
                'label' => 'Home laptop',
                'enabled' => true,
                'client_default_local_port' => 2080,
            ])
            ->call('create')
            ->assertHasNoFormErrors()
            ->assertRedirect();

        $account = ProxyAccount::query()->where('username', 'test2')->sole();
        $this->assertSame('Home laptop', $account->label);
        $this->assertSame(2080, $account->client_default_local_port);
        $this->assertSame(['vless_reality'], $account->enabled_protocols);
        $this->assertNotSame('', (string) $account->uuid);
        $this->assertSame('ya.ru', ServerConfig::current()->reality_dest_host);
        $this->assertSame(1, $generator->renderCalls);
        Notification::assertNotified('Proxy account created — URL ready');
    }

    #[Test]
    public function edit_save_preserves_existing_protocol_mode(): void
    {
        $admin = User::factory()->create();
        $account = ProxyAccount::factory()->create([
            'enabled_protocols' => ['vless_reality', 'hysteria2'],
        ]);

        Livewire::actingAs($admin)
            ->test(EditProxyAccount::class, ['record' => $account->getKey()])
            ->fillForm([
                'label' => 'cleaned',
            ])
            ->call('save', false, false)
            ->assertHasNoFormErrors();

        $this->assertSame(
            ['vless_reality', 'hysteria2'],
            $account->refresh()->enabled_protocols,
        );
    }
}

final class ProxyAccountResourceFakeSingBoxGenerator implements SingBoxConfigGeneratorInterface
{
    public int $renderCalls = 0;

    public function __construct(private readonly ?string $hash) {}

    public function renderToFile(): ?string
    {
        $this->renderCalls++;

        return $this->hash;
    }
}
