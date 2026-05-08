<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Jobs\ReloadSingBoxJob;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\Facades\Event;
use PHPUnit\Framework\Attributes\Test;
use RuntimeException;
use Tests\TestCase;

// Round-30 queue-retry-semantics audit. ReloadSingBoxJob's
// retries=3 + 5s backoff is documented in the class docstring.
// On exhaustion, Laravel calls failed() — pre-this round, no
// failed() handler existed and the operator's only signal was
// `php artisan queue:failed` from the container shell. The job's
// failure leaves the panel state and the running sing-box config
// diverged (Redis fast-path still keeps revocations effective,
// but the slow-path render+reload backstop has dropped).
//
// failed() now emits Log::critical so dashboard alarms fire and
// the operator's `docker compose logs panel` carries the event.
// These tests pin: (a) the log fires at CRITICAL level, (b) it
// carries the exception class + message + tries count, (c) the
// log message is the documented event name so dashboards can
// match on it.
class ReloadSingBoxJobFailedHandlerTest extends TestCase
{
    /** @var array<int, array{level:string, message:string, context:array}> */
    private array $logged = [];

    protected function setUp(): void
    {
        parent::setUp();
        $this->logged = [];
        Event::listen(MessageLogged::class, function (MessageLogged $e): void {
            $this->logged[] = ['level' => $e->level, 'message' => $e->message, 'context' => $e->context];
        });
    }

    /** @return array<int, array{level:string, message:string, context:array}> */
    private function loggedMatching(string $needle): array
    {
        return array_values(array_filter($this->logged, fn ($r) => str_contains($r['message'], $needle)));
    }

    #[Test]
    public function failed_handler_logs_at_critical_with_event_name(): void
    {
        $job = new ReloadSingBoxJob;
        $job->failed(new RuntimeException('clash API unreachable'));

        $hits = $this->loggedMatching('singbox.reload.job_failed');
        $this->assertCount(
            1,
            $hits,
            'failed() must emit exactly one singbox.reload.job_failed log line',
        );
        $this->assertSame(
            'critical',
            $hits[0]['level'],
            'CRITICAL — dashboards alarm at this level; ERROR would be too quiet',
        );
    }

    #[Test]
    public function failed_handler_includes_exception_type_and_message(): void
    {
        // The two operator-actionable diagnostics live in context:
        //   - `type` lets the operator grep "is this always
        //     RuntimeException, or does redis::ConnectionException
        //     show up too?"
        //   - `err` carries the underlying message so the operator
        //     doesn't need to chase the failed_jobs table to see
        //     the actual cause.
        $job = new ReloadSingBoxJob;
        $job->failed(new RuntimeException('clash PUT /configs: timeout'));

        $hit = $this->loggedMatching('singbox.reload.job_failed')[0];
        $this->assertSame(RuntimeException::class, $hit['context']['type']);
        $this->assertSame('clash PUT /configs: timeout', $hit['context']['err']);
        $this->assertSame(3, $hit['context']['tries']);
    }

    #[Test]
    public function failed_handler_carries_drift_warning_in_note(): void
    {
        // The note field documents the operational meaning for
        // an operator paging on the alarm at 3 AM: the Redis
        // fast-path already kept users revoked, so this is NOT a
        // security incident — it's a panel/proxy state-drift that
        // the next reconciliation tick clears.
        //
        // Pin the note so a future change that drops the
        // explanatory context fails this test (operator gets a
        // bare "job_failed" without the don't-page-security
        // qualifier).
        $job = new ReloadSingBoxJob;
        $job->failed(new RuntimeException('x'));

        $hit = $this->loggedMatching('singbox.reload.job_failed')[0];
        $this->assertArrayHasKey('note', $hit['context']);
        $this->assertStringContainsString(
            'Redis fast-path',
            $hit['context']['note'],
            'note must reassure operator the security path is unaffected',
        );
        $this->assertStringContainsString(
            'out of sync',
            $hit['context']['note'],
            'note must name the actual operational consequence (config drift)',
        );
    }
}
