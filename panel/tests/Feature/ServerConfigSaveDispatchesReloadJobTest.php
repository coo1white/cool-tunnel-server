<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Jobs\ReloadServerConfigJob;
use App\Models\ServerConfig;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use PHPUnit\Framework\Attributes\Test;
use RuntimeException;
use Tests\TestCase;

// v0.0.84 robustness-review fix (item 7). Pre-fix
// `ServerConfig::booted::updated` ran TWO ct-server-core renders
// + one clash-API reload SYNCHRONOUSLY inside the Filament
// request lifecycle, blocking the Octane worker for the full
// 60s subprocess timeout on every transient hang while the
// operator saw an unconditional "saved successfully"
// notification. Even when the inline shell-outs raised, both
// generators swallow the throw to a Log::critical and return
// null — the operator never saw the failure.
//
// The slow-path render+reload now runs in ReloadServerConfigJob,
// dispatched via DB::afterCommit so a rollback elsewhere in the
// transaction doesn't queue a phantom reload. This test pins the
// three semantic cases the dispatch contract MUST guarantee —
// same shape as ProxyAccountAfterCommitTest, which covered the
// ProxyAccount counterpart of this refactor.
class ServerConfigSaveDispatchesReloadJobTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function update_inside_rolled_back_transaction_does_not_dispatch_reload(): void
    {
        // current() seeds row id=1 on first call. Establish that
        // BEFORE Queue::fake() so the seed-time afterCommit (if
        // any) doesn't pollute the assertion.
        ServerConfig::current();

        Queue::fake();

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
        Queue::assertNothingPushed();
    }

    #[Test]
    public function update_inside_committed_transaction_dispatches_exactly_one_reload(): void
    {
        ServerConfig::current();

        Queue::fake();

        DB::transaction(function (): void {
            $config = ServerConfig::current();
            $config->update(['acme_email' => 'committed@example.com']);
        });

        Queue::assertPushed(ReloadServerConfigJob::class, 1);
    }

    #[Test]
    public function update_outside_transaction_dispatches_reload_immediately(): void
    {
        ServerConfig::current();

        Queue::fake();

        // No outer DB::transaction. afterCommit runs the callback
        // inline when no txn is active.
        $config = ServerConfig::current();
        $config->update(['acme_email' => 'inline@example.com']);

        Queue::assertPushed(ReloadServerConfigJob::class, 1);
    }
}
