<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Providers;

use App\MessageHandlers\ReloadServerConfigHandler;
use App\MessageHandlers\ReloadSingBoxHandler;
use App\Messages\ReloadServerConfig;
use App\Messages\ReloadSingBox;
use Illuminate\Support\ServiceProvider;
use Psr\Container\ContainerInterface;
use Symfony\Component\Messenger\Bridge\Redis\Transport\RedisTransportFactory;
use Symfony\Component\Messenger\Handler\HandlersLocator;
use Symfony\Component\Messenger\MessageBus;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Messenger\Middleware\HandleMessageMiddleware;
use Symfony\Component\Messenger\Middleware\SendMessageMiddleware;
use Symfony\Component\Messenger\Transport\InMemory\InMemoryTransport;
use Symfony\Component\Messenger\Transport\Sender\SendersLocator;
use Symfony\Component\Messenger\Transport\Serialization\PhpSerializer;
use Symfony\Component\Messenger\Transport\TransportInterface;

/**
 * Symfony Messenger wiring: bus + Redis transport + handlers.
 *
 * The panel dispatches reload messages directly from model events,
 * Filament actions, and operator-facing commands. The bus routes
 * those messages to Redis Streams for the Messenger worker.
 *
 * Routing: both messages map to the `async` transport, which is
 * a Redis Streams consumer-group on the `cool_tunnel:messenger`
 * stream. Symfony Messenger's worker reads via `XREADGROUP`,
 * acks via `XACK`, and parks failed messages on a sibling
 * `cool_tunnel:messenger:failed` stream (configured via
 * `failure_transport` in a later phase).
 *
 * Password handling: REDIS_PASSWORD is passed via the `auth`
 * option, NEVER interpolated into the DSN string. Mirror of
 * v0.0.88's Rust-core typed-builder fix — `openssl rand -base64`
 * passwords contain `/`, `+`, `=` which the redis-rs (and
 * redis-cli) URL parsers reject. The same hazard exists at the
 * PHP Redis layer; the `auth` option bypasses it entirely.
 *
 * Introduced in v0.0.93 as Phase 2 of the Symfony-infusion arc.
 */
class MessengerServiceProvider extends ServiceProvider
{
    /**
     * Redis Streams key used by the async transport. Distinct
     * namespace (`messenger:` prefix) so it doesn't collide with
     * Laravel's existing `cool_tunnel:revocations` pub/sub
     * channel or Laravel Queue's list-based `queues:default` key.
     */
    private const STREAM = 'cool_tunnel:messenger';

    /**
     * Consumer-group name. Multiple Messenger workers on the
     * same stream share the group and load-balance via Redis's
     * XREADGROUP semantics — exactly-once delivery per group.
     */
    private const CONSUMER_GROUP = 'cool_tunnel';

    public function register(): void
    {
        $this->app->singleton(TransportInterface::class, function () {
            // In the `testing` env (PHPUnit), use Messenger's
            // InMemoryTransport so the test runner doesn't need
            // `ext-redis` installed. The real Redis transport
            // still ships in production; we just don't exercise
            // its constructor path during unit/feature tests.
            // Tests can inspect the sent envelopes directly.
            if ($this->app->environment('testing')) {
                return new InMemoryTransport;
            }

            $host = (string) config('database.redis.default.host', 'redis');
            $port = (int) config('database.redis.default.port', 6379);
            $password = (string) config('database.redis.default.password', '');

            // DSN omits the password entirely. We pass it via the
            // `auth` option in $transportOptions below.
            $dsn = sprintf('redis://%s:%d/%s', $host, $port, self::STREAM);

            $transportOptions = [
                'stream' => self::STREAM,
                'group' => self::CONSUMER_GROUP,
                'consumer' => sprintf('worker-%d', getmypid() ?: 0),
                // Auto-claim messages whose consumer crashed
                // mid-process. 60s is short enough that a wedged
                // worker doesn't block its messages for long,
                // long enough that a healthy worker mid-handler
                // doesn't trigger spurious reassignment.
                'redeliver_timeout' => 60,
                // Symfony Messenger's `auto_setup` creates the
                // Redis stream + consumer group on first send if
                // missing. The operations are idempotent
                // (XGROUP CREATE with `MKSTREAM`); leaving this
                // on means a fresh deploy doesn't need a separate
                // bootstrap step.
                'auto_setup' => true,
            ];

            if ($password !== '') {
                $transportOptions['auth'] = $password;
            }

            return (new RedisTransportFactory)->createTransport(
                $dsn,
                $transportOptions,
                new PhpSerializer,
            );
        });

        $this->app->singleton(MessageBusInterface::class, function () {
            $transport = $this->app->make(TransportInterface::class);

            // SendersLocator wants a PSR-11 container mapping
            // transport-name → SenderInterface. We only have one
            // transport ("async"), so this is a trivial single-
            // entry container — clearer than reusing Laravel's
            // app container as a PSR-11 instance.
            $senderContainer = new class($transport) implements ContainerInterface
            {
                public function __construct(
                    private readonly TransportInterface $async,
                ) {}

                public function get(string $id): TransportInterface
                {
                    if ($id !== 'async') {
                        throw new \RuntimeException(sprintf(
                            'MessengerServiceProvider: unknown transport "%s" (only "async" is configured)',
                            $id,
                        ));
                    }

                    return $this->async;
                }

                public function has(string $id): bool
                {
                    return $id === 'async';
                }
            };

            // SendersLocator routes outbound messages to the
            // async transport. Both messages route to the same
            // transport; future messages can route to dedicated
            // transports without touching call sites.
            $sendersLocator = new SendersLocator(
                [
                    ReloadSingBox::class => ['async'],
                    ReloadServerConfig::class => ['async'],
                ],
                $senderContainer,
            );

            // HandlersLocator dispatches inbound messages from the
            // worker to handlers. Each handler is resolved through
            // Laravel's container so its constructor dependencies
            // (renderer / reloader / logger) inject correctly.
            $handlersLocator = new HandlersLocator([
                ReloadSingBox::class => [
                    fn (ReloadSingBox $m) => ($this->app->make(ReloadSingBoxHandler::class))($m),
                ],
                ReloadServerConfig::class => [
                    fn (ReloadServerConfig $m) => ($this->app->make(ReloadServerConfigHandler::class))($m),
                ],
            ]);

            return new MessageBus([
                new SendMessageMiddleware($sendersLocator),
                new HandleMessageMiddleware($handlersLocator),
            ]);
        });
    }
}
