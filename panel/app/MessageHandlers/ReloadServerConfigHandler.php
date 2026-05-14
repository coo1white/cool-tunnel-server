<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\MessageHandlers;

use App\Contracts\CaddyfileGeneratorInterface;
use App\Contracts\SingBoxConfigGeneratorInterface;
use App\Contracts\SingBoxReloaderInterface;
use App\Messages\ReloadServerConfig;
use Psr\Log\LoggerInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * Slow-path render+reload handler for `ServerConfig` changes.
 * Symfony Messenger equivalent of the legacy
 * `App\Jobs\ReloadServerConfigJob::handle()` with identical
 * semantics: render Caddyfile first (so the cert path is in
 * place before sing-box re-reads it), then render sing-box,
 * then reload sing-box if its config changed.
 *
 * Hash-idempotent at both renderer layers; safe to run twice.
 * Failures bubble out as exceptions for Messenger's retry path
 * to handle.
 *
 * Introduced in v0.0.93 as Phase 2 of the Symfony-infusion arc.
 */
#[AsMessageHandler]
final class ReloadServerConfigHandler
{
    public function __construct(
        private readonly CaddyfileGeneratorInterface $caddy,
        private readonly SingBoxConfigGeneratorInterface $singbox,
        private readonly SingBoxReloaderInterface $reloader,
        private readonly LoggerInterface $logger,
    ) {}

    public function __invoke(ReloadServerConfig $message): void
    {
        // Caddyfile first — operator's "I changed the panel
        // domain" case lands the new TLS cert path before sing-
        // box's render hash reads cert mtime on the next reload.
        $this->caddy->renderToFile();

        $hash = $this->singbox->renderToFile();
        if ($hash !== null) {
            $this->reloader->reload();

            return;
        }

        $this->logger->debug('serverconfig.reload.handler_no_op_on_singbox_render_null', [
            'reason' => $message->reason,
        ]);
    }
}
