<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\FakeWebsite;
use App\Models\ProxyAccount;
use App\Models\ServerConfig;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

final class SubscriptionRealityDestinationTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function manifest_uses_the_configured_reality_destination(): void
    {
        ServerConfig::factory()->create(['reality_dest_host' => 'ya.ru']);
        FakeWebsite::factory()->active()->create();
        $account = ProxyAccount::factory()->create();

        $response = $this->get('/api/v1/subscription/'.$account->subscriptionToken());
        $this->assertSame(200, $response->status());

        $decoded = json_decode($response->getContent(), true, flags: JSON_THROW_ON_ERROR);
        $this->assertSame('ya.ru', $decoded['profiles'][0]['reality']['dest_host']);
    }

    #[Test]
    public function empty_reality_destination_falls_through_to_cover_site(): void
    {
        ServerConfig::factory()->create(['reality_dest_host' => '']);
        FakeWebsite::factory()->active()->create();
        $account = ProxyAccount::factory()->create();

        $cover = $this->get('/cover-baseline-'.bin2hex(random_bytes(4)));
        $sub = $this->get('/api/v1/subscription/'.$account->subscriptionToken());

        $this->assertSame($cover->status(), $sub->status());
        $this->assertSame($cover->headers->get('Content-Type'), $sub->headers->get('Content-Type'));
        $this->assertSame($cover->getContent(), $sub->getContent());
    }

    #[Test]
    public function malformed_reality_destination_falls_through_to_cover_site(): void
    {
        ServerConfig::factory()->create(['reality_dest_host' => 'https://']);
        FakeWebsite::factory()->active()->create();
        $account = ProxyAccount::factory()->create();

        $cover = $this->get('/cover-baseline-'.bin2hex(random_bytes(4)));
        $sub = $this->get('/api/v1/subscription/'.$account->subscriptionToken());

        $this->assertSame($cover->status(), $sub->status());
        $this->assertSame($cover->headers->get('Content-Type'), $sub->headers->get('Content-Type'));
        $this->assertSame($cover->getContent(), $sub->getContent());
    }
}
