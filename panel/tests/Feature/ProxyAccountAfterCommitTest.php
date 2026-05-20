<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Messages\ReloadSingBox;
use App\Models\ProxyAccount;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Test;
use RuntimeException;
use Symfony\Component\Messenger\Transport\InMemory\InMemoryTransport;
use Symfony\Component\Messenger\Transport\TransportInterface;
use Tests\TestCase;

// v0.0.15 C1 + v0.0.94 cutover. `ProxyAccount::booted::saved` and
// `::deleted` defer the Redis announce + ReloadSingBox dispatch to
// `DB::afterCommit`. Pre-v0.0.15, both ran inline in the model
// event — which fires AFTER the row's INSERT/UPDATE but BEFORE the
// surrounding transaction commits. A rollback elsewhere in the
// same transaction left behind a Redis ghost flag for a row that
// never persisted, plus a queued reload for a phantom change.
//
// The dispatch surface is Symfony Messenger:
// `MessageBusInterface::dispatch(new ReloadSingBox(...))`. The
// assertion reads the bus's InMemoryTransport directly.
//
// This fixture verifies the three semantic cases the
// `DB::afterCommit` shape MUST guarantee:
//
//   1. Save inside a rolled-back transaction → NO message dispatched.
//   2. Save inside a committed transaction → exactly one message
//      dispatched, after commit.
//   3. Save outside any transaction → message dispatched immediately
//      (afterCommit runs callback inline when no txn is active).
//
// Plus the same three for the `deleted` event.

class ProxyAccountAfterCommitTest extends TestCase
{
    use RefreshDatabase;

    /**
     * Empty the InMemoryTransport so message counts start at zero
     * for each test. `RefreshDatabase` rebuilds the schema between
     * tests but doesn't reset the Messenger transport (it's a
     * singleton in the app container).
     */
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
                'MessengerServiceProvider::register() should bind '.
                'InMemoryTransport when app->environment("testing"). '.
                'See CHANGELOG [0.0.93].',
                $transport::class,
            ));
        }

        return $transport;
    }

    /** @return list<ReloadSingBox> */
    private function dispatchedReloadMessages(): array
    {
        $out = [];
        foreach ($this->transport()->getSent() as $envelope) {
            $msg = $envelope->getMessage();
            if ($msg instanceof ReloadSingBox) {
                $out[] = $msg;
            }
        }

        return $out;
    }

    #[Test]
    public function save_inside_rolled_back_transaction_does_no_t_dispatch_reload(): void
    {
        try {
            DB::transaction(function (): void {
                ProxyAccount::factory()->create();
                throw new RuntimeException('forced rollback for test');
            });
        } catch (RuntimeException) {
            // Expected.
        }

        // Pre-v0.0.15 this assertion would have FAILED — the
        // dispatch fired inline in `saved`, before the rollback
        // had a chance to undo the row.
        $this->assertCount(0, $this->dispatchedReloadMessages());
    }

    #[Test]
    public function save_inside_committed_transaction_dispatches_exactly_one_reload(): void
    {
        DB::transaction(function (): void {
            ProxyAccount::factory()->create();
        });

        $this->assertCount(1, $this->dispatchedReloadMessages());
    }

    #[Test]
    public function save_outside_transaction_dispatches_reload_immediately(): void
    {
        // No outer DB::transaction. afterCommit runs the
        // callback inline when no txn is active — pre-v0.0.15
        // inline-dispatch behaviour preserved for this case.
        ProxyAccount::factory()->create();

        $this->assertCount(1, $this->dispatchedReloadMessages());
    }

    #[Test]
    public function deleted_inside_rolled_back_transaction_does_no_t_dispatch_reload(): void
    {
        // Deleted-event handler has the same DB::afterCommit
        // shape as saved-event handler. Same invariant must hold.
        $account = ProxyAccount::factory()->create();
        $this->transport()->reset(); // start counting AFTER the create dispatch

        try {
            DB::transaction(function () use ($account): void {
                $account->delete();
                throw new RuntimeException('forced rollback for test');
            });
        } catch (RuntimeException) {
            // Expected.
        }

        $this->assertCount(0, $this->dispatchedReloadMessages());
        $this->assertNotNull(
            ProxyAccount::find($account->id),
            'rollback should have un-done the delete',
        );
    }

    #[Test]
    public function dispatched_message_carries_descriptive_reason(): void
    {
        // v0.0.94 added a `reason` field to ReloadSingBox so
        // operator-side observability can distinguish saved-from-
        // active, saved-from-revoked, and deleted dispatches.
        // Validate the saved-active path produces an active reason.
        ProxyAccount::factory()->create(['enabled' => true]);

        $msgs = $this->dispatchedReloadMessages();
        $this->assertCount(1, $msgs);
        $this->assertStringStartsWith(
            'proxy_account.saved:',
            $msgs[0]->reason,
            'reason should encode the saved-event subkind for log correlation',
        );
    }
}
