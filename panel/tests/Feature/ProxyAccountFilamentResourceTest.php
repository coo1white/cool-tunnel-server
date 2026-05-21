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
use App\Support\RenderResult;
use Filament\Notifications\Notification;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
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
            'username' => 'home-laptop',
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

        $this->assertFalse(Schema::hasColumn('proxy_accounts', 'used_bytes'));
        $this->assertFalse(Schema::hasColumn('proxy_accounts', 'quota_bytes'));
    }

    #[Test]
    public function edit_form_presents_mode_as_read_only_core_state(): void
    {
        $admin = User::factory()->create();
        $account = ProxyAccount::factory()->create([
            'enabled_protocols' => ['vless_reality', 'hysteria2'],
        ]);
        DB::table('proxy_accounts')
            ->where('id', $account->id)
            ->update(['enabled_protocols' => json_encode(['vless_reality', 'hysteria2'])]);

        Livewire::actingAs($admin)
            ->test(EditProxyAccount::class, ['record' => $account->getKey()])
            ->assertFormComponentExists('protocol_mode')
            ->assertFormComponentDoesNotExist('enabled_protocols')
            ->assertSeeText('VLESS + Reality active');
    }

    #[Test]
    public function edit_form_does_not_silently_default_stale_only_protocol_rows(): void
    {
        $admin = User::factory()->create();
        $account = ProxyAccount::factory()->create([
            'enabled_protocols' => ['hysteria2'],
        ]);
        DB::table('proxy_accounts')
            ->where('id', $account->id)
            ->update(['enabled_protocols' => json_encode(['hysteria2'])]);

        Livewire::actingAs($admin)
            ->test(EditProxyAccount::class, ['record' => $account->getKey()])
            ->assertFormComponentExists('protocol_mode')
            ->assertFormComponentDoesNotExist('enabled_protocols')
            ->assertSeeText('No active core mode');
    }

    #[Test]
    public function create_form_creates_core_account_without_rotating_reality_destination(): void
    {
        $admin = User::factory()->create();
        ServerConfig::factory()->create(['reality_dest_host' => 'ya.ru']);
        $generator = new ProxyAccountResourceFakeSingBoxGenerator(RenderResult::changed(str_repeat('a', 64)));
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $generator);

        Livewire::actingAs($admin)
            ->test(CreateProxyAccount::class)
            ->assertFormComponentExists('protocol_mode')
            ->assertFormComponentExists('reality_dest_host_current')
            ->assertFormComponentDoesNotExist('enabled_protocols')
            ->assertFormComponentDoesNotExist('reality_dest_host')
            ->assertSeeText('VLESS + Reality active')
            ->assertSeeText('Yandex (ya.ru)')
            ->fillForm([
                'username' => 'home-laptop',
                'label' => 'Home laptop',
                'enabled' => true,
                'client_default_local_port' => 2080,
            ])
            ->call('create')
            ->assertHasNoFormErrors()
            ->assertRedirect();

        $account = ProxyAccount::query()->where('username', 'home-laptop')->sole();
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
        ServerConfig::factory()->create(['reality_dest_host' => 'www.apple.com']);
        $account = ProxyAccount::factory()->create([
            'enabled_protocols' => ['vless_reality', 'hysteria2'],
        ]);
        $generator = new ProxyAccountResourceFakeSingBoxGenerator(RenderResult::changed(str_repeat('b', 64)));
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $generator);

        Livewire::actingAs($admin)
            ->test(EditProxyAccount::class, ['record' => $account->getKey()])
            ->assertFormComponentExists('reality_dest_host_current')
            ->assertFormComponentDoesNotExist('reality_dest_host')
            ->assertSeeText('Apple (www.apple.com)')
            ->fillForm([
                'label' => 'Updated laptop',
            ])
            ->call('save', false, true)
            ->assertHasNoFormErrors();

        $this->assertSame(
            ['vless_reality'],
            $account->refresh()->enabled_protocols,
        );
        $this->assertSame('www.apple.com', ServerConfig::current()->reality_dest_host);
        $this->assertSame(1, $generator->renderCalls);
        Notification::assertNotified('Proxy account saved — config current');
    }

    #[Test]
    public function edit_save_warns_when_immediate_render_fails(): void
    {
        $admin = User::factory()->create();
        $account = ProxyAccount::factory()->create();
        $generator = new ProxyAccountResourceFakeSingBoxGenerator(RenderResult::failed());
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $generator);

        Livewire::actingAs($admin)
            ->test(EditProxyAccount::class, ['record' => $account->getKey()])
            ->fillForm([
                'label' => 'Pending render',
            ])
            ->call('save', false, true)
            ->assertHasNoFormErrors();

        $this->assertSame(1, $generator->renderCalls);
        Notification::assertNotified('Proxy account saved — reload queued');
    }

    #[Test]
    public function table_delete_confirms_immediate_render(): void
    {
        $admin = User::factory()->create();
        $account = ProxyAccount::factory()->create();
        $generator = new ProxyAccountResourceFakeSingBoxGenerator(RenderResult::changed(str_repeat('c', 64)));
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $generator);

        Livewire::actingAs($admin)
            ->test(ListProxyAccounts::class)
            ->callTableAction('delete', $account)
            ->assertHasNoTableActionErrors();

        $this->assertModelMissing($account);
        $this->assertSame(1, $generator->renderCalls);
        Notification::assertNotified('Proxy account deleted — config current');
    }

    #[Test]
    public function table_bulk_delete_confirms_immediate_render_once(): void
    {
        $admin = User::factory()->create();
        $accounts = ProxyAccount::factory()->count(2)->create();
        $generator = new ProxyAccountResourceFakeSingBoxGenerator(RenderResult::changed(str_repeat('d', 64)));
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $generator);

        Livewire::actingAs($admin)
            ->test(ListProxyAccounts::class)
            ->callTableBulkAction('delete', $accounts)
            ->assertHasNoTableBulkActionErrors();

        $accounts->each(fn (ProxyAccount $account) => $this->assertModelMissing($account));
        $this->assertSame(1, $generator->renderCalls);
        Notification::assertNotified('Proxy accounts deleted — config current');
    }
}

final class ProxyAccountResourceFakeSingBoxGenerator implements SingBoxConfigGeneratorInterface
{
    public int $renderCalls = 0;

    public function __construct(private readonly RenderResult $result) {}

    public function renderToFile(): RenderResult
    {
        $this->renderCalls++;

        return $this->result;
    }
}
