<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Jobs\ReloadSingBoxJob;
use App\Models\ProxyAccount;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use PHPUnit\Framework\Attributes\Test;
use RuntimeException;
use Tests\TestCase;

// v0.0.15 C1 — `ProxyAccount::booted::saved` defers the Redis
// announce + ReloadSingBoxJob dispatch to `DB::afterCommit`. Pre-
// fix, both ran inline in the model event, which fires AFTER the
// row's INSERT/UPDATE but BEFORE the surrounding transaction
// commits. A rollback elsewhere in the same transaction left
// behind a Redis ghost flag for a row that never persisted, plus
// a queued reload for a phantom change.
//
// This test fixture verifies the three semantic cases the
// `DB::afterCommit` shape MUST guarantee:
//
//   1. Save inside a rolled-back transaction → NO job dispatched.
//   2. Save inside a committed transaction → exactly one job
//      dispatched, after commit.
//   3. Save outside any transaction → job dispatched immediately
//      (afterCommit runs callback inline when no txn is active).
//
// Job count is the assertion lever — Queue::fake() captures
// dispatched jobs without actually running them, and Queue::
// assertNothingPushed / assertPushed give us the binary signal.
// Redis side is implicitly covered because `RedisRevocationBus`
// calls and `ReloadSingBoxJob::dispatch` are inside the same
// `DB::afterCommit` closure — if the job fired, the announce
// fired; if the job didn't fire, neither did.
//
// (v0.0.20 — Loop-6 self-check, closes the deferred test gap on
// the v0.0.15 C1 critical fix.)

class ProxyAccountAfterCommitTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function save_inside_rolled_back_transaction_does_NOT_dispatch_reload(): void
    {
        Queue::fake();

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
        Queue::assertNothingPushed();
    }

    #[Test]
    public function save_inside_committed_transaction_dispatches_exactly_one_reload(): void
    {
        Queue::fake();

        DB::transaction(function (): void {
            ProxyAccount::factory()->create();
        });

        Queue::assertPushed(ReloadSingBoxJob::class, 1);
    }

    #[Test]
    public function save_outside_transaction_dispatches_reload_immediately(): void
    {
        Queue::fake();

        // No outer DB::transaction. afterCommit runs the
        // callback inline when no txn is active — pre-v0.0.15
        // inline-dispatch behaviour preserved for this case.
        ProxyAccount::factory()->create();

        Queue::assertPushed(ReloadSingBoxJob::class, 1);
    }

    #[Test]
    public function deleted_inside_rolled_back_transaction_does_NOT_dispatch_reload(): void
    {
        // Deleted-event handler has the same DB::afterCommit
        // shape as saved-event handler. Same invariant must hold.
        $account = ProxyAccount::factory()->create();
        Queue::fake();  // start counting AFTER the create dispatch

        try {
            DB::transaction(function () use ($account): void {
                $account->delete();
                throw new RuntimeException('forced rollback for test');
            });
        } catch (RuntimeException) {
            // Expected.
        }

        Queue::assertNothingPushed();
        $this->assertNotNull(
            ProxyAccount::find($account->id),
            'rollback should have un-done the delete',
        );
    }
}
