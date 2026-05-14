<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcher;
use Symfony\Component\Messenger\EventListener\StopWorkerOnMemoryLimitListener;
use Symfony\Component\Messenger\EventListener\StopWorkerOnTimeLimitListener;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Messenger\Transport\TransportInterface;
use Symfony\Component\Messenger\Worker;

/**
 * Artisan wrapper around Symfony Messenger's Worker class.
 *
 * Supervisord runs this as the [program:messenger] long-lived
 * process. The Worker pulls envelopes off the async transport
 * (Redis Streams via `cool_tunnel:messenger`), dispatches them
 * through the bus, and the bus's `HandleMessageMiddleware`
 * routes each to its registered handler.
 *
 * Why an Artisan wrapper rather than calling Symfony Console's
 * `bin/console messenger:consume` directly: Laravel's bootstrap
 * is required for `app(...)` resolution of the
 * `SingBoxConfigGeneratorInterface` / `SingBoxReloaderInterface`
 * / `CaddyfileGeneratorInterface` bindings that the handlers
 * depend on. The cleanest reuse of that bootstrap is Artisan.
 *
 * Stop conditions:
 *   - `--time-limit`: hard wall-clock cap. Defaults to 3600s
 *     (one hour) so the worker cycles regularly and doesn't
 *     accumulate worker-mode state. supervisord auto-restarts.
 *   - `--memory-limit`: per-worker recycle threshold. 128M
 *     matches the existing Laravel queue worker's posture.
 *
 * Both are enforced via Messenger's event-listener pattern: the
 * Worker emits `WorkerRunningEvent` after each message; the
 * listeners check their threshold and call `Worker::stop()`,
 * which exits the worker loop cleanly after the in-flight
 * message finishes.
 *
 * Introduced in v0.0.93 as Phase 2 of the Symfony-infusion arc.
 */
final class MessengerConsume extends Command
{
    protected $signature = 'messenger:consume
                            {transport=async : transport name (only "async" is configured)}
                            {--time-limit=3600 : seconds before graceful shutdown}
                            {--memory-limit=128M : worker recycle memory threshold}';

    protected $description = 'Run a Symfony Messenger worker against the configured Redis transport.';

    public function handle(
        TransportInterface $transport,
        MessageBusInterface $bus,
        LoggerInterface $logger,
    ): int {
        $name = (string) $this->argument('transport');
        if ($name !== 'async') {
            $this->error("Unknown transport: {$name} (only \"async\" is configured)");

            return self::FAILURE;
        }

        $timeLimit = (int) $this->option('time-limit');
        $memoryLimit = (string) $this->option('memory-limit');

        $dispatcher = new EventDispatcher;
        $dispatcher->addSubscriber(new StopWorkerOnTimeLimitListener($timeLimit, $logger));
        $dispatcher->addSubscriber(new StopWorkerOnMemoryLimitListener(
            $this->parseMemoryLimit($memoryLimit),
            $logger,
        ));

        $worker = new Worker(
            ['async' => $transport],
            $bus,
            $dispatcher,
            $logger,
        );

        $this->info(sprintf(
            'messenger:consume starting (transport=async, time-limit=%ds, memory-limit=%s, pid=%d)',
            $timeLimit,
            $memoryLimit,
            getmypid() ?: 0,
        ));

        $worker->run();

        return self::SUCCESS;
    }

    /**
     * Convert a human-readable memory limit (e.g. "128M", "1G")
     * to bytes. StopWorkerOnMemoryLimitListener takes bytes.
     */
    private function parseMemoryLimit(string $limit): int
    {
        $limit = trim($limit);
        if ($limit === '') {
            return 128 * 1024 * 1024;
        }

        $unit = strtoupper(substr($limit, -1));
        $value = (int) $limit;

        return match ($unit) {
            'G' => $value * 1024 * 1024 * 1024,
            'M' => $value * 1024 * 1024,
            'K' => $value * 1024,
            default => $value,
        };
    }
}
