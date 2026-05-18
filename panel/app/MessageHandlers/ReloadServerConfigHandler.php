<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\MessageHandlers;

use App\Contracts\CaddyfileGeneratorInterface;
use App\Contracts\SingBoxConfigGeneratorInterface;
use App\Messages\ReloadServerConfig;
use Psr\Log\LoggerInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * ServerConfig change handler.
 *
 * v0.4.0+ order of operations:
 *
 *   1. Render the Caddyfile (still mostly-static — only Domain /
 *      PanelDomain / ACME email / ACME directory live in there).
 *      A domain/email change re-renders cleanly; hash-idempotent.
 *   2. Render /data/config/singbox.json via SingBoxConfigGenerator
 *      (shells to `singbox-core render-server`). A ServerConfig
 *      change can affect the Reality keypair / dest_host / domain
 *      embedded in the singbox config, so we always re-render.
 *      ct-singbox's `singbox-core supervise` picks up the new file
 *      via fs.watch and respawns sing-box within ~250 ms.
 *
 * Both renderers are hash-idempotent; failures bubble out as
 * exceptions for Messenger's retry path.
 */
#[AsMessageHandler]
final class ReloadServerConfigHandler
{
    public function __construct(
        private readonly CaddyfileGeneratorInterface $caddy,
        private readonly SingBoxConfigGeneratorInterface $singbox,
        private readonly LoggerInterface $logger,
    ) {}

    public function __invoke(ReloadServerConfig $message): void
    {
        $this->caddy->renderToFile();

        $singboxHash = $this->singbox->renderToFile();
        if ($singboxHash === null) {
            $this->logger->debug('serverconfig.reload.singbox_render_no_op', [
                'reason' => $message->reason,
            ]);
        }
    }
}
