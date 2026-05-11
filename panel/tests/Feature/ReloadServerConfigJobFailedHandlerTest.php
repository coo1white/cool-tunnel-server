<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Jobs\ReloadServerConfigJob;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\Facades\Event;
use PHPUnit\Framework\Attributes\Test;
use RuntimeException;
use Tests\TestCase;

// v0.0.84 robustness-review fix (item 7) — companion to the
// existing `ReloadSingBoxJobFailedHandlerTest`. The slow-path
// render+reload backstop for ServerConfig changes now runs in
// `ReloadServerConfigJob`. On retry exhaustion (3 tries × 5s
// backoff), the job's `failed()` handler must surface a
// CRITICAL-level log line so dashboards alarm — without it the
// only signal is `php artisan queue:failed` from the panel
// container shell, invisible from the panel UI and invisible
// to dashboards.
//
// The Redis fast-path keeps the daemon in sync with the new
// config even when this slow-path fails, so this is NOT a
// security incident — but operators MUST see it surfaced as
// drift between the rendered config and the running sing-box.
//
// These tests pin the contract:
//   (a) the log fires at CRITICAL level
//   (b) the message is the documented event name
//       `serverconfig.reload.job_failed` (so dashboards can match
//       on it deterministically)
//   (c) the context carries the exception class + message + tries
//       count for operator triage
//   (d) the context carries the drift-vs-security explanation so
//       the 3am operator paged on the alarm doesn't escalate to
//       security
class ReloadServerConfigJobFailedHandlerTest extends TestCase
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
        $job = new ReloadServerConfigJob;
        $job->failed(new RuntimeException('clash API unreachable'));

        $hits = $this->loggedMatching('serverconfig.reload.job_failed');
        $this->assertCount(
            1,
            $hits,
            'failed() must emit exactly one serverconfig.reload.job_failed log line',
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
        $job = new ReloadServerConfigJob;
        $job->failed(new RuntimeException('clash PUT /configs: timeout'));

        $hit = $this->loggedMatching('serverconfig.reload.job_failed')[0];
        $this->assertSame(RuntimeException::class, $hit['context']['type']);
        $this->assertSame('clash PUT /configs: timeout', $hit['context']['err']);
        $this->assertSame(3, $hit['context']['tries']);
    }

    #[Test]
    public function failed_handler_carries_drift_vs_security_note(): void
    {
        // The note field documents the operational meaning for an
        // operator paging on the alarm at 3 AM: the Redis fast-
        // path already kept the daemon in sync, so this is NOT a
        // security incident — it's a panel/disk-state drift that
        // the next reconciliation tick clears.
        //
        // Pin the note so a future change that drops the
        // explanatory context fails this test (operator gets a
        // bare "job_failed" without the don't-page-security
        // context).
        $job = new ReloadServerConfigJob;
        $job->failed(new RuntimeException('any failure'));

        $hit = $this->loggedMatching('serverconfig.reload.job_failed')[0];
        $this->assertStringContainsString('Redis fast-path', $hit['context']['note']);
        $this->assertStringContainsString('slow-path drift', $hit['context']['note']);
    }
}
