<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\MessageHandlers;

use App\Contracts\NaiveConfigGeneratorInterface;
use App\Messages\ReloadSingBox;
use Psr\Log\LoggerInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * Per-account credential change handler.
 *
 * Class name preserved (still `ReloadSingBox*`) because the message
 * type + symfony bindings are referenced from external dispatch
 * sites; renaming would force a coordinated churn. The behaviour
 * underneath has shifted twice:
 *
 *   v0.1.x  — render sing-box config.json; PUT to clash-API for
 *             a live reload.
 *   v0.2.x  — render Caddyfile basic_auth block; reload Caddy.
 *   v0.3.0+ — render /data/config/naive.json. ct-naive's Bun
 *             supervisor file-watches the path and respawns naive
 *             within ~250 ms. NO reload-side shell-out is needed
 *             here — the file write IS the reload trigger. This
 *             also means we no longer depend on the broken
 *             docker-exec path in CtServerCore::reloadCaddy()
 *             (the panel container lacks the docker CLI, a known
 *             v0.2.x limitation).
 *
 *   - Hash-idempotent at the renderer layer.
 *   - `null` from the generator means "nothing changed".
 *   - Domain-level failures bubble out for Messenger's retry.
 */
#[AsMessageHandler]
final class ReloadSingBoxHandler
{
    public function __construct(
        private readonly NaiveConfigGeneratorInterface $generator,
        private readonly LoggerInterface $logger,
    ) {}

    public function __invoke(ReloadSingBox $message): void
    {
        $hash = $this->generator->renderToFile();
        if ($hash !== null) {
            // File write is the reload primitive. ct-naive's
            // supervisor will respawn naive on its next debounced
            // file-watch tick (~250 ms).
            $this->logger->info('naive.reload.rendered', [
                'hash' => $hash,
                'reason' => $message->reason,
            ]);

            return;
        }

        $this->logger->debug('naive.reload.handler_no_op_on_render_null', [
            'reason' => $message->reason,
        ]);
    }
}
