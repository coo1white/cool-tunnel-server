<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Contracts\CaddyfileGeneratorInterface;
use App\Contracts\NaiveConfigGeneratorInterface;
use App\Contracts\SingBoxReloaderInterface;
use App\MessageHandlers\ReloadServerConfigHandler;
use App\Messages\ReloadServerConfig;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// v0.3.0 cutover. ReloadServerConfigHandler's invocation contract:
//
//   1. Render Caddyfile FIRST. The Caddyfile is mostly static now
//      (Domain / PanelDomain / ACME bindings only) but a
//      domain/email change must propagate before the naive renderer
//      tries to compute the new cert path.
//   2. If Caddyfile changed, reload Caddy (still uses the legacy
//      SingBoxReloader::reload() interface, whose concrete
//      implementation now wraps caddy-reload).
//   3. Render /data/config/naive.json. ct-naive's supervisor file-
//      watches the path and respawns naive automatically — no
//      explicit reload-side shell-out from PHP.

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
    public function handler_renders_caddy_first_then_naive_then_reloads_caddy_on_change(): void
    {
        $caddy = new RecordingCaddyGenerator('sha256-caddy');
        $naive = new RecordingNaiveGenerator('sha256-naive');
        $reloader = new RecordingSingBoxReloader;
        $this->app->instance(CaddyfileGeneratorInterface::class, $caddy);
        $this->app->instance(NaiveConfigGeneratorInterface::class, $naive);
        $this->app->instance(SingBoxReloaderInterface::class, $reloader);

        $this->app->make(ReloadServerConfigHandler::class)(new ReloadServerConfig(reason: 'test'));

        $this->assertSame(
            ['caddy', 'reload', 'naive'],
            self::$invocationLog,
            'Caddyfile render MUST come before naive render (cert path feeds in); '
            .'Caddy reload MUST come between them if the Caddyfile changed.',
        );
    }

    #[Test]
    public function handler_skips_caddy_reload_when_caddyfile_unchanged(): void
    {
        $caddy = new RecordingCaddyGenerator(null);  // "unchanged"
        $naive = new RecordingNaiveGenerator('sha256-naive');
        $reloader = new RecordingSingBoxReloader;
        $this->app->instance(CaddyfileGeneratorInterface::class, $caddy);
        $this->app->instance(NaiveConfigGeneratorInterface::class, $naive);
        $this->app->instance(SingBoxReloaderInterface::class, $reloader);

        $this->app->make(ReloadServerConfigHandler::class)(new ReloadServerConfig(reason: 'test'));

        $this->assertSame(1, $caddy->renderCalls);
        $this->assertSame(1, $naive->renderCalls, 'naive.json still renders even if Caddyfile was unchanged.');
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

final class RecordingNaiveGenerator implements NaiveConfigGeneratorInterface
{
    public int $renderCalls = 0;

    public function __construct(private readonly ?string $hash) {}

    public function renderToFile(): ?string
    {
        $this->renderCalls++;
        ReloadServerConfigHandlerTest::recordInvocation('naive');

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
