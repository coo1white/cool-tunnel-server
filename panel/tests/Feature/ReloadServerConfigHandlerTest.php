<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Contracts\CaddyfileGeneratorInterface;
use App\Contracts\SingBoxConfigGeneratorInterface;
use App\Contracts\SingBoxReloaderInterface;
use App\MessageHandlers\ReloadServerConfigHandler;
use App\Messages\ReloadServerConfig;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// v0.0.94 cutover. ReloadServerConfigHandler's invocation contract:
// render Caddyfile FIRST (so the new TLS cert path lands before
// sing-box re-reads it on its next reload — sing-box's render hash
// feeds in cert mtime, so order matters for one-pass reconciliation),
// then render sing-box, then reload sing-box only if its hash
// changed.

class ReloadServerConfigHandlerTest extends TestCase
{
    /** @var list<string> */
    private static array $invocationLog = [];

    protected function setUp(): void
    {
        parent::setUp();
        self::$invocationLog = [];
    }

    #[Test]
    public function handler_renders_caddy_first_then_singbox_then_reloads_on_change(): void
    {
        $caddy = new RecordingCaddyGenerator('sha256-caddy');
        $singbox = new RecordingSingBoxGenerator('sha256-singbox');
        $reloader = new RecordingSingBoxReloader;
        $this->app->instance(CaddyfileGeneratorInterface::class, $caddy);
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $singbox);
        $this->app->instance(SingBoxReloaderInterface::class, $reloader);

        $this->app->make(ReloadServerConfigHandler::class)(new ReloadServerConfig(reason: 'test'));

        $this->assertSame(
            ['caddy', 'singbox', 'reload'],
            self::$invocationLog,
            'Caddyfile render MUST come before sing-box render (cert mtime feeds in); sing-box reload MUST come after both renders.',
        );
    }

    #[Test]
    public function handler_skips_singbox_reload_when_singbox_render_returns_null(): void
    {
        $caddy = new RecordingCaddyGenerator('sha256-caddy');
        $singbox = new RecordingSingBoxGenerator(null);  // "unchanged"
        $reloader = new RecordingSingBoxReloader;
        $this->app->instance(CaddyfileGeneratorInterface::class, $caddy);
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $singbox);
        $this->app->instance(SingBoxReloaderInterface::class, $reloader);

        $this->app->make(ReloadServerConfigHandler::class)(new ReloadServerConfig(reason: 'test'));

        $this->assertSame(1, $caddy->renderCalls, 'Caddyfile still renders even if sing-box render returns null.');
        $this->assertSame(1, $singbox->renderCalls);
        $this->assertSame(
            0,
            $reloader->reloadCalls,
            'sing-box reload MUST be skipped when its render returned null.',
        );
    }

    public static function recordInvocation(string $event): void
    {
        self::$invocationLog[] = $event;
    }
}

final class RecordingCaddyGenerator implements CaddyfileGeneratorInterface
{
    public int $renderCalls = 0;

    public function __construct(private readonly ?string $hash) {}

    public function renderToFile(): ?string
    {
        $this->renderCalls++;
        ReloadServerConfigHandlerTest::recordInvocation('caddy');

        return $this->hash;
    }
}

final class RecordingSingBoxGenerator implements SingBoxConfigGeneratorInterface
{
    public int $renderCalls = 0;

    public function __construct(private readonly ?string $hash) {}

    public function renderToFile(): ?string
    {
        $this->renderCalls++;
        ReloadServerConfigHandlerTest::recordInvocation('singbox');

        return $this->hash;
    }
}

final class RecordingSingBoxReloader implements SingBoxReloaderInterface
{
    public int $reloadCalls = 0;

    public function reload(): bool
    {
        $this->reloadCalls++;
        ReloadServerConfigHandlerTest::recordInvocation('reload');

        return true;
    }
}
