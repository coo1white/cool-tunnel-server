<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\MessageHandlers;

use App\Contracts\SingBoxConfigGeneratorInterface;
use App\Messages\ReloadSingBox;
use Psr\Log\LoggerInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * Per-account credential change handler.
 *
 * Class name preserved (still `ReloadSingBox*`) because the message
 * type + symfony bindings are referenced from external dispatch
 * sites; renaming would force a coordinated churn. The renderer
 * underneath has shifted four times:
 *
 *   v0.1.x  — render sing-box config.json; PUT to clash-API.
 *   v0.2.x  — render Caddyfile basic_auth block; reload Caddy.
 *   v0.3.x  — render /data/config/naive.json (then ct-naive's
 *             supervisor file-watched it). Abandoned: naive can't
 *             actually run as an HTTPS server.
 *   v0.4.0+ — render /data/config/singbox.json via singbox-core.
 *             ct-singbox's `singbox-core supervise` file-watches
 *             the path and respawns sing-box within ~250 ms. No
 *             reload-side shell-out from PHP.
 *
 *   - Hash-idempotent at the renderer layer.
 *   - `null` from the generator means "nothing changed".
 *   - Domain-level failures bubble out for Messenger's retry.
 */
#[AsMessageHandler]
final class ReloadSingBoxHandler
{
    public function __construct(
        private readonly SingBoxConfigGeneratorInterface $generator,
        private readonly LoggerInterface $logger,
    ) {}

    public function __invoke(ReloadSingBox $message): void
    {
        $hash = $this->generator->renderToFile();
        if ($hash !== null) {
            // File write is the reload primitive. ct-singbox's
            // supervisor will respawn sing-box on its next debounced
            // file-watch tick (~250 ms).
            $this->logger->info('singbox.reload.rendered', [
                'hash' => $hash,
                'reason' => $message->reason,
            ]);

            return;
        }

        $this->logger->debug('singbox.reload.handler_no_op_on_render_null', [
            'reason' => $message->reason,
        ]);
    }
}
