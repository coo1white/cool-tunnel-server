<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\MessageHandlers;

use App\Contracts\CaddyfileGeneratorInterface;
use App\Contracts\NaiveConfigGeneratorInterface;
use App\Contracts\SingBoxReloaderInterface;
use App\Messages\ReloadServerConfig;
use Psr\Log\LoggerInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * ServerConfig change handler.
 *
 * v0.3.0+ order of operations:
 *
 *   1. Render the (now mostly-static) Caddyfile. Only Domain /
 *      PanelDomain / ACME email / ACME directory live in there;
 *      account credentials moved to naive.json. The render is
 *      hash-idempotent — re-running on an unchanged config is
 *      a no-op.
 *   2. If the Caddyfile changed, ask Caddy to reload (still uses
 *      the legacy SingBoxReloader::reload() interface, whose
 *      concrete implementation now shells to caddy-reload via
 *      `docker exec`; the panel-container-lacks-docker problem
 *      is a known v0.2.x carry-over).
 *   3. Render /data/config/naive.json — domain change affects
 *      which cert path ct-naive resolves. The supervisor's file-
 *      watch picks up the new naive.json and respawns naive
 *      automatically. No reload-side shell-out from PHP.
 *
 * Both renderers are hash-idempotent at the wire layer; failures
 * bubble out as exceptions for Messenger's retry path.
 */
#[AsMessageHandler]
final class ReloadServerConfigHandler
{
    public function __construct(
        private readonly CaddyfileGeneratorInterface $caddy,
        private readonly NaiveConfigGeneratorInterface $naive,
        private readonly SingBoxReloaderInterface $reloader,
        private readonly LoggerInterface $logger,
    ) {}

    public function __invoke(ReloadServerConfig $message): void
    {
        // Caddyfile first so a domain/PanelDomain change lands its
        // cert acquisition before ct-naive looks up the cert
        // pair.
        $caddyHash = $this->caddy->renderToFile();
        if ($caddyHash !== null) {
            $this->reloader->reload();
        }

        $naiveHash = $this->naive->renderToFile();
        if ($naiveHash === null) {
            $this->logger->debug('serverconfig.reload.naive_render_no_op', [
                'reason' => $message->reason,
            ]);
        }
    }
}
