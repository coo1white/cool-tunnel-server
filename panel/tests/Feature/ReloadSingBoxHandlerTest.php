<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Contracts\SingBoxConfigGeneratorInterface;
use App\MessageHandlers\ReloadSingBoxHandler;
use App\Messages\ReloadSingBox;
use App\Support\RenderResult;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// v0.4.0 — the handler renders /data/config/singbox.json via
// SingBoxConfigGenerator (which shells to `singbox-core render-server`
// per docker/panel/Dockerfile's bundled binary). The file write IS
// the reload primitive — ct-singbox's `singbox-core supervise` file-
// watches the path and respawns sing-box within ~250 ms. No explicit
// reload-side shell-out from PHP anymore.
//
// Class name `ReloadSingBox*` is preserved through every architecture
// cut (sing-box → caddy forwardproxy → naive → singbox-vless-reality)
// because renaming the message + symfony bindings would cascade through
// every external dispatch site.

class ReloadSingBoxHandlerTest extends TestCase
{
    #[Test]
    public function handler_renders_when_invoked(): void
    {
        $generator = new FakeSingBoxGenerator(RenderResult::changed(str_repeat('a', 64)));
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $generator);

        $this->app->make(ReloadSingBoxHandler::class)(new ReloadSingBox(reason: 'test:hash-changed'));

        $this->assertSame(
            1,
            $generator->renderCalls,
            'The handler MUST call renderToFile() exactly once per invocation.',
        );
    }

    #[Test]
    public function handler_tolerates_unchanged_render_no_op(): void
    {
        // RenderResult::unchanged() means "file unchanged on disk".
        // Supervisor file-watch won't fire; nothing else to do.
        // Handler must NOT throw; this test pins that posture.
        $generator = new FakeSingBoxGenerator(RenderResult::unchanged());
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $generator);

        $this->app->make(ReloadSingBoxHandler::class)(new ReloadSingBox(reason: 'test:render-null'));

        $this->assertSame(1, $generator->renderCalls);
    }

    #[Test]
    public function handler_throws_when_render_failed_so_messenger_can_retry(): void
    {
        $generator = new FakeSingBoxGenerator(RenderResult::failed());
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $generator);

        try {
            $this->app->make(ReloadSingBoxHandler::class)(new ReloadSingBox(reason: 'test:render-failed'));
            $this->fail('Failed render results must bubble out of the handler.');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('sing-box render failed', $e->getMessage());
        }

        $this->assertSame(1, $generator->renderCalls);
    }
}

// Local test double. Plain class (not anonymous) so
// app->instance(...) retains the same object identity for the
// renderCalls assertion after the handler runs.
final class FakeSingBoxGenerator implements SingBoxConfigGeneratorInterface
{
    public int $renderCalls = 0;

    public function __construct(private readonly RenderResult $result) {}

    public function renderToFile(): RenderResult
    {
        $this->renderCalls++;

        return $this->result;
    }
}
