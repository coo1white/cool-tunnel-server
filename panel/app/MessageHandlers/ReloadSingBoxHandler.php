<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\MessageHandlers;

use App\Contracts\SingBoxConfigGeneratorInterface;
use App\Contracts\SingBoxReloaderInterface;
use App\Messages\ReloadSingBox;
use Psr\Log\LoggerInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * Slow-path render+reload handler for sing-box. Symfony Messenger
 * equivalent of the legacy `App\Jobs\ReloadSingBoxJob::handle()`,
 * with the same contracts:
 *
 *   - Hash-idempotent at the renderer layer — racing two
 *     handlers back-to-back is a no-op-after-first.
 *   - `null` from the generator means "nothing changed; skip
 *     the clash-API call". The handler emits a `debug`-level
 *     trace line so an operator inspecting logs can see the
 *     no-op without noise.
 *   - Domain-level failures (Redis publish error, clash-API
 *     timeout) bubble out of the handler as exceptions —
 *     Messenger's retry-on-error path picks them up via the
 *     retry strategy configured in `MessengerServiceProvider`.
 *     Permanent-failure surfacing (the equivalent of the legacy
 *     `failed()` hook + `Log::critical('singbox.reload.job_failed')`)
 *     happens via the `failure_transport` once retries are
 *     exhausted; until then this handler stays narrow.
 *
 * Introduced in v0.0.93 as Phase 2 of the Symfony-infusion arc.
 */
#[AsMessageHandler]
final class ReloadSingBoxHandler
{
    public function __construct(
        private readonly SingBoxConfigGeneratorInterface $generator,
        private readonly SingBoxReloaderInterface $reloader,
        private readonly LoggerInterface $logger,
    ) {}

    public function __invoke(ReloadSingBox $message): void
    {
        $hash = $this->generator->renderToFile();
        if ($hash !== null) {
            $this->reloader->reload();

            return;
        }

        // Generator already logged at critical on real failure;
        // this debug line gives the operator a per-message
        // timeline cross-ref for the no-change case.
        $this->logger->debug('singbox.reload.handler_no_op_on_render_null', [
            'reason' => $message->reason,
        ]);
    }
}
