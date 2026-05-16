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

// v0.4.0 — ReloadServerConfigHandler's invocation contract:
//
//   1. Render Caddyfile FIRST. The Caddyfile is mostly static
//      (Domain / PanelDomain / ACME bindings only) but a
//      domain/email change must propagate before the sing-box
//      renderer tries to compute the new cert path.
//   2. If Caddyfile changed, reload Caddy (still uses the legacy
//      SingBoxReloader::reload() interface, whose concrete
//      implementation now wraps caddy-reload).
//   3. Render /data/config/singbox.json. ct-singbox's
//      `singbox-core supervise` file-watches the path and respawns
//      sing-box automatically — no explicit reload-side shell-out
//      from PHP.

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
    public function handler_renders_caddy_first_then_singbox_then_reloads_caddy_on_change(): void
    {
        $caddy = new RecordingCaddyGenerator('sha256-caddy');
        $singbox = new RecordingSingBoxGenerator('sha256-singbox');
        $reloader = new RecordingSingBoxReloader;
        $this->app->instance(CaddyfileGeneratorInterface::class, $caddy);
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $singbox);
        $this->app->instance(SingBoxReloaderInterface::class, $reloader);

        $this->app->make(ReloadServerConfigHandler::class)(new ReloadServerConfig(reason: 'test'));

        $this->assertSame(
            ['caddy', 'reload', 'singbox'],
            self::$invocationLog,
            'Caddyfile render MUST come before singbox render (cert path feeds in); '
            .'Caddy reload MUST come between them if the Caddyfile changed.',
        );
    }

    #[Test]
    public function handler_skips_caddy_reload_when_caddyfile_unchanged(): void
    {
        $caddy = new RecordingCaddyGenerator(null);  // "unchanged"
        $singbox = new RecordingSingBoxGenerator('sha256-singbox');
        $reloader = new RecordingSingBoxReloader;
        $this->app->instance(CaddyfileGeneratorInterface::class, $caddy);
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $singbox);
        $this->app->instance(SingBoxReloaderInterface::class, $reloader);

        $this->app->make(ReloadServerConfigHandler::class)(new ReloadServerConfig(reason: 'test'));

        $this->assertSame(1, $caddy->renderCalls);
        $this->assertSame(
            1,
            $singbox->renderCalls,
            'singbox.json still renders even if Caddyfile was unchanged.',
        );
        $this->assertSame(
            0,
            $reloader->reloadCalls,
            'Caddy reload MUST be skipped when the Caddyfile render returned null.',
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
