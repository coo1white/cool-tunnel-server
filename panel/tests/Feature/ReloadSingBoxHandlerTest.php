<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Contracts\SingBoxConfigGeneratorInterface;
use App\Contracts\SingBoxReloaderInterface;
use App\MessageHandlers\ReloadSingBoxHandler;
use App\Messages\ReloadSingBox;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// v0.0.94 cutover. ReloadSingBoxJob's `failed()` hook + tests are
// gone; the equivalent failure-surfacing concern in Symfony
// Messenger is the `failure_transport` mechanism (Messenger's
// retry strategy + dedicated failed-message transport). That's
// deferred to a later release — Phase 3 retains correctness by
// pinning the handler's *invocation contract* against fakes of
// the two service collaborators it depends on.

class ReloadSingBoxHandlerTest extends TestCase
{
    #[Test]
    public function handler_renders_and_reloads_when_hash_changes(): void
    {
        $generator = new FakeSingBoxGenerator('sha256-of-new-content');
        $reloader = new FakeSingBoxReloader;
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $generator);
        $this->app->instance(SingBoxReloaderInterface::class, $reloader);

        $this->app->make(ReloadSingBoxHandler::class)(new ReloadSingBox(reason: 'test:hash-changed'));

        $this->assertSame(1, $generator->renderCalls);
        $this->assertSame(
            1,
            $reloader->reloadCalls,
            'When renderToFile returns a non-null hash, the handler MUST call reload() exactly once.',
        );
    }

    #[Test]
    public function handler_skips_reload_when_render_returns_null(): void
    {
        $generator = new FakeSingBoxGenerator(null);  // "unchanged"
        $reloader = new FakeSingBoxReloader;
        $this->app->instance(SingBoxConfigGeneratorInterface::class, $generator);
        $this->app->instance(SingBoxReloaderInterface::class, $reloader);

        $this->app->make(ReloadSingBoxHandler::class)(new ReloadSingBox(reason: 'test:render-null'));

        $this->assertSame(1, $generator->renderCalls);
        $this->assertSame(
            0,
            $reloader->reloadCalls,
            'When renderToFile returns null, the handler MUST NOT call reload() — the file is unchanged so a reload would be wasted I/O.',
        );
    }
}

// Local test doubles. Plain classes (not anonymous) so the
// `app->instance(...)` binding retains the same object identity
// for assertion access after `handle()` runs.
final class FakeSingBoxGenerator implements SingBoxConfigGeneratorInterface
{
    public int $renderCalls = 0;

    public function __construct(private readonly ?string $hash) {}

    public function renderToFile(): ?string
    {
        $this->renderCalls++;

        return $this->hash;
    }
}

final class FakeSingBoxReloader implements SingBoxReloaderInterface
{
    public int $reloadCalls = 0;

    public function reload(): bool
    {
        $this->reloadCalls++;

        return true;
    }
}
