<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Messages\ReloadServerConfig;
use App\Models\ServerConfig;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Test;
use RuntimeException;
use Symfony\Component\Messenger\Transport\InMemory\InMemoryTransport;
use Symfony\Component\Messenger\Transport\TransportInterface;
use Tests\TestCase;

// `ServerConfig::booted::updated` dispatches `ReloadServerConfig`
// through Symfony Messenger inside `DB::afterCommit`. The contract
// is the same three semantic cases — rolled-back / committed /
// no-transaction — and the assertion reads the Messenger bus's
// InMemoryTransport directly.

class ServerConfigSaveDispatchesReloadMessageTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->transport()->reset();
    }

    private function transport(): InMemoryTransport
    {
        $transport = app(TransportInterface::class);
        if (! $transport instanceof InMemoryTransport) {
            $this->fail(sprintf(
                'Expected InMemoryTransport in testing env, got %s. '.
                'See MessengerServiceProvider + CHANGELOG [0.0.93].',
                $transport::class,
            ));
        }

        return $transport;
    }

    /** @return list<ReloadServerConfig> */
    private function dispatchedReloadMessages(): array
    {
        $out = [];
        foreach ($this->transport()->getSent() as $envelope) {
            $msg = $envelope->getMessage();
            if ($msg instanceof ReloadServerConfig) {
                $out[] = $msg;
            }
        }

        return $out;
    }

    #[Test]
    public function update_inside_rolled_back_transaction_does_not_dispatch_reload(): void
    {
        // current() seeds row id=1 on first call. Establish that
        // BEFORE resetting the transport so the seed-time dispatch
        // (if any) doesn't pollute the assertion.
        ServerConfig::current();
        $this->transport()->reset();

        try {
            DB::transaction(function (): void {
                $config = ServerConfig::current();
                $config->update(['acme_email' => 'rolled-back@example.com']);
                throw new RuntimeException('forced rollback for test');
            });
        } catch (RuntimeException) {
            // Expected.
        }

        // Pre-fix this would have FAILED — the dispatch fired
        // inline in `updated`, before the rollback had a chance
        // to undo the row.
        $this->assertCount(0, $this->dispatchedReloadMessages());
    }

    #[Test]
    public function update_inside_committed_transaction_dispatches_exactly_one_reload(): void
    {
        ServerConfig::current();
        $this->transport()->reset();

        DB::transaction(function (): void {
            $config = ServerConfig::current();
            $config->update(['acme_email' => 'committed@example.com']);
        });

        $msgs = $this->dispatchedReloadMessages();
        $this->assertCount(1, $msgs);
        $this->assertSame('server_config.updated', $msgs[0]->reason);
    }

    #[Test]
    public function update_outside_transaction_dispatches_reload_immediately(): void
    {
        ServerConfig::current();
        $this->transport()->reset();

        // No outer DB::transaction. afterCommit runs the callback
        // inline when no txn is active.
        $config = ServerConfig::current();
        $config->update(['acme_email' => 'inline@example.com']);

        $this->assertCount(1, $this->dispatchedReloadMessages());
    }
}
