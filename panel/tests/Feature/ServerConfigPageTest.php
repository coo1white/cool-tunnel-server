<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Contracts\SingBoxConfigGeneratorInterface;
use App\Filament\Pages\ServerConfigPage;
use App\Models\ServerConfig;
use App\Models\User;
use App\Support\RenderResult;
use App\Support\RealityDestinationCatalog;
use Filament\Notifications\Notification;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Livewire\Livewire;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

final class ServerConfigPageTest extends TestCase
{
    use RefreshDatabase;

    protected function tearDown(): void
    {
        RealityDestinationCatalog::useLatencyProbeForTests(null);
        Cache::flush();

        parent::tearDown();
    }

    #[Test]
    public function page_exposes_and_saves_global_reality_destination(): void
    {
        $admin = User::factory()->create();
        ServerConfig::factory()->create([
            'domain' => 'proxy.example.com',
            'acme_email' => 'admin@example.com',
            'acme_directory' => 'https://acme-staging-v02.api.letsencrypt.org/directory',
            'reality_dest_host' => 'www.microsoft.com',
        ]);
        $generator = new ServerConfigPageFakeSingBoxGenerator(RenderResult::changed(str_repeat('f', 64)));
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $generator);

        Livewire::actingAs($admin)
            ->test(ServerConfigPage::class)
            ->assertFormFieldExists('reality_dest_host')
            ->assertFormSet([
                'reality_dest_host' => 'www.microsoft.com',
            ])
            ->fillForm([
                'reality_dest_host' => 'ya.ru',
            ])
            ->call('save')
            ->assertHasNoFormErrors();

        $this->assertSame('ya.ru', ServerConfig::current()->reality_dest_host);
        $this->assertSame(1, $generator->renderCalls);
        Notification::assertNotified('Server config saved — config current');
    }

    #[Test]
    public function reality_destination_save_warns_when_immediate_render_fails(): void
    {
        $admin = User::factory()->create();
        ServerConfig::factory()->create([
            'domain' => 'proxy.example.com',
            'acme_email' => 'admin@example.com',
            'acme_directory' => 'https://acme-staging-v02.api.letsencrypt.org/directory',
            'reality_dest_host' => 'www.microsoft.com',
        ]);
        $generator = new ServerConfigPageFakeSingBoxGenerator(RenderResult::failed());
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $generator);

        Livewire::actingAs($admin)
            ->test(ServerConfigPage::class)
            ->fillForm([
                'reality_dest_host' => 'ya.ru',
            ])
            ->call('save')
            ->assertHasNoFormErrors();

        $this->assertSame('ya.ru', ServerConfig::current()->reality_dest_host);
        $this->assertSame(1, $generator->renderCalls);
        Notification::assertNotified('Server config saved (reload path degraded)');
    }

    #[Test]
    public function latency_refresh_updates_cache_without_changing_global_destination(): void
    {
        $admin = User::factory()->create();
        ServerConfig::factory()->create([
            'domain' => 'proxy.example.com',
            'acme_email' => 'admin@example.com',
            'acme_directory' => 'https://acme-staging-v02.api.letsencrypt.org/directory',
            'reality_dest_host' => 'www.apple.com',
        ]);

        RealityDestinationCatalog::useLatencyProbeForTests(fn (string $host): int => $host === 'www.apple.com' ? 28 : 83);

        Livewire::actingAs($admin)
            ->test(ServerConfigPage::class)
            ->assertFormSet([
                'reality_dest_host' => 'www.apple.com',
            ])
            ->call('refreshRealityLatency')
            ->assertHasNoErrors();

        $this->assertSame('www.apple.com', ServerConfig::current()->reality_dest_host);
        $this->assertSame(28, RealityDestinationCatalog::cachedLatency('www.apple.com')['latency_ms']);
        Notification::assertNotified('Reality destination latency refreshed');
    }

    #[Test]
    public function page_mount_warms_latency_cache_for_dropdown_labels(): void
    {
        $admin = User::factory()->create();
        ServerConfig::factory()->create([
            'domain' => 'proxy.example.com',
            'acme_email' => 'admin@example.com',
            'acme_directory' => 'https://acme-staging-v02.api.letsencrypt.org/directory',
            'reality_dest_host' => 'www.apple.com',
        ]);

        RealityDestinationCatalog::useLatencyProbeForTests(fn (string $host): int => $host === 'www.apple.com' ? 34 : 12);

        Livewire::actingAs($admin)
            ->test(ServerConfigPage::class)
            ->assertSee('34 ms');

        $this->assertSame(34, RealityDestinationCatalog::cachedLatency('www.apple.com')['latency_ms']);
    }

    #[Test]
    public function page_renders_latency_check_action(): void
    {
        $admin = User::factory()->create();
        ServerConfig::factory()->create([
            'domain' => 'proxy.example.com',
            'acme_email' => 'admin@example.com',
            'acme_directory' => 'https://acme-staging-v02.api.letsencrypt.org/directory',
            'reality_dest_host' => 'www.apple.com',
        ]);

        Livewire::actingAs($admin)
            ->test(ServerConfigPage::class)
            ->assertSee('Check latency')
            ->assertSee('Save and reload');
    }
}

final class ServerConfigPageFakeSingBoxGenerator implements SingBoxConfigGeneratorInterface
{
    public int $renderCalls = 0;

    public function __construct(private readonly RenderResult $result) {}

    public function renderToFile(): RenderResult
    {
        $this->renderCalls++;

        return $this->result;
    }
}
