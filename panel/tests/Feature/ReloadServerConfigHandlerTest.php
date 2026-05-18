<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Contracts\CaddyfileGeneratorInterface;
use App\Contracts\SingBoxConfigGeneratorInterface;
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
//   2. Render /data/config/singbox.json. ct-singbox's
//      `singbox-core supervise` file-watches the path and respawns
//      sing-box automatically.

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
    public function handler_renders_caddy_first_then_singbox(): void
    {
        $caddy = new RecordingCaddyGenerator('sha256-caddy');
        $singbox = new RecordingSingBoxGenerator('sha256-singbox');
        $this->app->instance(CaddyfileGeneratorInterface::class, $caddy);
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $singbox);

        $this->app->make(ReloadServerConfigHandler::class)(new ReloadServerConfig(reason: 'test'));

        $this->assertSame(
            ['caddy', 'singbox'],
            self::$invocationLog,
            'Caddyfile render MUST come before singbox render (cert path feeds in).',
        );
    }

    #[Test]
    public function handler_still_renders_singbox_when_caddyfile_unchanged(): void
    {
        $caddy = new RecordingCaddyGenerator(null);  // "unchanged"
        $singbox = new RecordingSingBoxGenerator('sha256-singbox');
        $this->app->instance(CaddyfileGeneratorInterface::class, $caddy);
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $singbox);

        $this->app->make(ReloadServerConfigHandler::class)(new ReloadServerConfig(reason: 'test'));

        $this->assertSame(1, $caddy->renderCalls);
        $this->assertSame(
            1,
            $singbox->renderCalls,
            'singbox.json still renders even if Caddyfile was unchanged.',
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
