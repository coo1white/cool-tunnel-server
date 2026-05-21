<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Unit;

use App\Contracts\CtServerCoreInterface;
use App\Models\ProxyAccount;
use App\Models\ServerConfig;
use App\Services\CaddyfileGenerator;
use App\Services\SingBoxConfigGenerator;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// Pins the error-boundary contract of the two thin shell-out
// generators that bridge the panel save flow to its rendering
// helpers:
//
//   - CaddyfileGenerator still shells through CtServerCore (the
//     Rust binary owns the Caddyfile templating). Failure-class
//     semantics unchanged from v0.3.x: \RuntimeException is soft
//     (render returns null, surrounding save commits, scheduler
//     reconciles); \Error is hard (re-thrown so a code defect
//     surfaces as a 500 instead of a silent diverge).
//
//   - SingBoxConfigGenerator (v0.4.0+) shells directly to
//     /usr/local/bin/singbox-core render-server with a JSON
//     ServerRenderInput on stdin. Failure-class semantics:
//       * Missing prerequisites (no reality_private_key,
//         reality_dest_host) — hard: throw \RuntimeException at
//         input-build time. These are server-side misconfigurations,
//         not transient failures; the operator MUST hit a 500 and
//         the panel logs the cause, not silently render with garbage.
//       * Binary spawn / non-zero exit / non-JSON outcome — soft:
//         log critical, return RenderResult::failed(). These are
//         transient (panel container restart, docker filesystem
//         hiccup) and Messenger retries / the every-5-min scheduled
//         `singbox:render --if-changed` reconcile.
//
// The v0.3.x test exercised mock-CtServerCore failure modes; v0.4.0
// exercises DB-driven prerequisites (Reality keypair, dest host).
// The shell-out side is integration territory (CI runs the docker
// stack); unit tests here cover the deterministic input-build path.

final class GeneratorErrorBoundaryTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function singbox_throws_when_reality_private_key_is_missing(): void
    {
        // First-boot deploy: ServerConfig row exists but the
        // operator hasn't run reality-keygen yet. Rendering would
        // produce a config sing-box rejects at load time; the
        // generator hard-fails so the surrounding handler doesn't
        // silently write a broken file.
        ServerConfig::factory()->create(['reality_private_key' => null]);
        ProxyAccount::factory()->create();

        $gen = $this->app->make(SingBoxConfigGenerator::class);

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches('/reality_private_key/i');
        $gen->renderToFile();
    }

    #[Test]
    public function singbox_throws_when_reality_dest_host_is_empty(): void
    {
        // Reality requires a cover-site SNI. An empty string would
        // render a sing-box config with `server_name: ""`, which
        // sing-box's vless inbound rejects at load.
        ServerConfig::factory()->create(['reality_dest_host' => '']);
        ProxyAccount::factory()->create();

        $gen = $this->app->make(SingBoxConfigGenerator::class);

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches('/reality_dest_host/i');
        $gen->renderToFile();
    }

    #[Test]
    public function singbox_throws_when_reality_dest_host_is_malformed(): void
    {
        ServerConfig::factory()->create(['reality_dest_host' => 'https://']);
        ProxyAccount::factory()->create();

        $gen = $this->app->make(SingBoxConfigGenerator::class);

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches('/reality_dest_host/i');
        $gen->renderToFile();
    }

    #[Test]
    public function singbox_render_input_normalizes_reality_dest_host(): void
    {
        ServerConfig::factory()->create(['reality_dest_host' => 'HTTPS://Ya.Ru/some/path']);
        ProxyAccount::factory()->create();

        $gen = $this->app->make(SingBoxConfigGenerator::class);
        $method = new \ReflectionMethod($gen, 'buildRenderInput');
        $method->setAccessible(true);

        /** @var array<string,mixed> $input */
        $input = $method->invoke($gen);

        $this->assertSame('ya.ru', $input['reality_dest_host']);
    }

    #[Test]
    public function singbox_render_input_carries_direct_outbound_dial_policy(): void
    {
        ServerConfig::factory()->create();
        ProxyAccount::factory()->create();

        config([
            'cool-tunnel.singbox_direct_domain_strategy' => 'ipv4_only',
            'cool-tunnel.singbox_direct_connect_timeout' => '1500ms',
            'cool-tunnel.singbox_direct_fallback_delay' => '50ms',
        ]);

        $gen = $this->app->make(SingBoxConfigGenerator::class);
        $method = new \ReflectionMethod($gen, 'buildRenderInput');
        $method->setAccessible(true);

        /** @var array<string,mixed> $input */
        $input = $method->invoke($gen);

        $this->assertSame('ipv4_only', $input['direct_domain_strategy']);
        $this->assertSame('1500ms', $input['direct_connect_timeout']);
        $this->assertSame('50ms', $input['direct_fallback_delay']);
    }

    #[Test]
    public function singbox_render_input_only_includes_active_accounts(): void
    {
        ServerConfig::factory()->create();
        $active = ProxyAccount::factory()->create(['username' => 'active-user']);
        ProxyAccount::factory()->disabled()->create(['username' => 'disabled-user']);
        ProxyAccount::factory()->expired()->create(['username' => 'expired-user']);

        $gen = $this->app->make(SingBoxConfigGenerator::class);
        $method = new \ReflectionMethod($gen, 'buildRenderInput');
        $method->setAccessible(true);

        /** @var array<string,mixed> $input */
        $input = $method->invoke($gen);

        $this->assertSame([
            [
                'username' => 'active-user',
                'uuid' => $active->uuid,
            ],
        ], $input['accounts']);
    }

    #[Test]
    public function singbox_render_input_uses_placeholder_when_no_accounts_are_active(): void
    {
        ServerConfig::factory()->create();
        ProxyAccount::factory()->disabled()->create(['username' => 'disabled-user']);
        ProxyAccount::factory()->expired()->create(['username' => 'expired-user']);

        $gen = $this->app->make(SingBoxConfigGenerator::class);
        $method = new \ReflectionMethod($gen, 'buildRenderInput');
        $method->setAccessible(true);

        /** @var array<string,mixed> $input */
        $input = $method->invoke($gen);

        $this->assertSame([
            [
                'username' => '__no_active_accounts__',
                'uuid' => '00000000-0000-0000-0000-000000000000',
            ],
        ], $input['accounts']);
    }

    #[Test]
    public function caddyfile_soft_fails_on_runtime_exception(): void
    {
        $core = $this->createMock(CtServerCoreInterface::class);
        $core->method('renderCaddyfile')
            ->willThrowException(new \RuntimeException('ct-server-core exited 1'));

        $gen = new CaddyfileGenerator($core);

        $this->assertNull(
            $gen->renderToFile(),
            'A transient \RuntimeException must soft-fail to null so the surrounding save still commits.',
        );
    }

    #[Test]
    public function caddyfile_rethrows_on_error(): void
    {
        $core = $this->createMock(CtServerCoreInterface::class);
        $core->method('renderCaddyfile')
            ->willThrowException(new \Error('class not found'));

        $gen = new CaddyfileGenerator($core);

        $this->expectException(\Error::class);
        $gen->renderToFile();
    }
}
