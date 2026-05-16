<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Contracts\NaiveConfigGeneratorInterface;
use App\MessageHandlers\ReloadSingBoxHandler;
use App\Messages\ReloadSingBox;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// v0.3.0 cutover. The handler now renders /data/config/naive.json
// via NaiveConfigGenerator; the file write IS the reload primitive
// (ct-naive's Bun supervisor file-watches the path and respawns
// naive automatically). The v0.2.x SingBoxReloader::reload() step
// is gone — there's no explicit reload-side shell-out anymore.
//
// Class name "ReloadSingBox*" preserved through both architecture
// cuts (sing-box → caddy forwardproxy → naive container) because
// renaming the message + symfony bindings would cascade through
// every external dispatch site.

class ReloadSingBoxHandlerTest extends TestCase
{
    #[Test]
    public function handler_renders_when_invoked(): void
    {
        $generator = new FakeNaiveGenerator('sha256-of-new-content');
        $this->app->instance(NaiveConfigGeneratorInterface::class, $generator);

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
        // null from the generator means "file unchanged on disk".
        // Supervisor file-watch won't fire; nothing else to do.
        // Handler must NOT throw; this test pins that posture.
        $generator = new FakeNaiveGenerator(null);
        $this->app->instance(NaiveConfigGeneratorInterface::class, $generator);

        $this->app->make(ReloadSingBoxHandler::class)(new ReloadSingBox(reason: 'test:render-null'));

        $this->assertSame(1, $generator->renderCalls);
    }
}

// Local test double. Plain class (not anonymous) so
// app->instance(...) retains the same object identity for the
// renderCalls assertion after the handler runs.
final class FakeNaiveGenerator implements NaiveConfigGeneratorInterface
{
    public int $renderCalls = 0;

    public function __construct(private readonly ?string $hash) {}

    public function renderToFile(): ?string
    {
        $this->renderCalls++;

        return $this->hash;
    }
}
