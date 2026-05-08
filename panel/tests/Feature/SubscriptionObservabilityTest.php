<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\FakeWebsite;
use App\Models\ProxyAccount;
use App\Models\ServerConfig;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\Facades\Event;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// Round-12 observability tests. Pin the contract for which
// SubscriptionController fall-throughs MUST emit panel-side logs
// (so the operator can debug "user X says their URL stopped
// working") versus which paths must STAY silent (probe-class
// paths that would amplify scanner traffic into log spam at China-
// bound scan rates).
//
// Captures via `Event::listen(MessageLogged)` rather than
// `Log::spy()` because Laravel's spy doesn't compose with the
// channel chain Filament uses; the event fires regardless of
// driver and gives us the level + context.
class SubscriptionObservabilityTest extends TestCase
{
    use RefreshDatabase;

    /** @var array<int, array{level:string, message:string, context:array}> */
    private array $logged = [];

    protected function setUp(): void
    {
        parent::setUp();
        $this->logged = [];
        Event::listen(MessageLogged::class, function (MessageLogged $e): void {
            $this->logged[] = [
                'level' => $e->level,
                'message' => $e->message,
                'context' => $e->context,
            ];
        });
    }

    private function seedActiveCover(): void
    {
        ServerConfig::factory()->create();
        FakeWebsite::factory()->active()->create();
    }

    /** @return array<int, array{level:string, message:string, context:array}> */
    private function loggedMatching(string $messageNeedle): array
    {
        return array_values(array_filter(
            $this->logged,
            fn ($r) => str_contains($r['message'], $messageNeedle),
        ));
    }

    #[Test]
    public function unknown_token_does_not_emit_per_request_log(): void
    {
        // Probe-class path. A scanner hammering /api/v1/subscription
        // with random tokens would 1:1 amplify into panel logs if
        // we logged each invalid resolution — a legit DoS-via-logs
        // amplifier. Cardinality control: stay silent here, rely on
        // FakeSiteController's per-IP-per-minute aggregator.
        $this->seedActiveCover();

        $bogus = 'definitely-not-a-real-token-'.bin2hex(random_bytes(8));
        $this->get('/api/v1/subscription/'.$bogus);

        $this->assertEmpty(
            $this->loggedMatching('subscription.fallthrough'),
            'unknown-token path must NOT log per request '
            .'(would amplify scanner traffic into log spam): '
            .json_encode($this->loggedMatching('subscription.fallthrough')),
        );
    }

    #[Test]
    public function disabled_account_logs_warning_with_account_id(): void
    {
        // Legitimate user, real row, but operator disabled them
        // (or expiry passed). Cardinality bounded by user count.
        // Operator MUST be able to grep for this when a user says
        // "my URL stopped working" — without the log, the only
        // surface is the cover-site 200, identical to the bogus-
        // token path.
        $this->seedActiveCover();
        $account = ProxyAccount::factory()->create(['enabled' => false]);
        $account->setCleartextPassword('s3cr3t');
        $account->save();

        $this->get('/api/v1/subscription/'.$account->subscriptionToken());

        $hits = $this->loggedMatching('subscription.fallthrough.account_disabled');
        $this->assertCount(1, $hits, 'disabled account must log exactly once per request');
        $this->assertSame('warning', $hits[0]['level']);
        $this->assertSame($account->id, $hits[0]['context']['account_id']);
        $this->assertSame($account->username, $hits[0]['context']['username']);
    }

    #[Test]
    public function empty_cleartext_logs_critical_with_account_id(): void
    {
        // Active account, working token, but cleartext column is
        // empty/undecryptable — APP_KEY rotation or legacy row.
        // This is the operator-must-fix-NOW scenario; CRITICAL is
        // the right level so dashboards alert.
        $this->seedActiveCover();
        $account = ProxyAccount::factory()->create();
        $account->password_cleartext_encrypted = null;
        $account->saveQuietly();

        $this->get('/api/v1/subscription/'.$account->subscriptionToken());

        $hits = $this->loggedMatching('subscription.fallthrough.cleartext_decrypt_failed');
        $this->assertCount(1, $hits, 'broken cleartext must log exactly once per request');
        $this->assertSame('critical', $hits[0]['level']);
        $this->assertSame($account->id, $hits[0]['context']['account_id']);
        $this->assertSame($account->username, $hits[0]['context']['username']);
    }

    #[Test]
    public function happy_path_emits_no_fall_through_logs(): void
    {
        // Sanity: a successful manifest serve must NOT emit any
        // subscription.fallthrough.* log. If it did, the operator
        // would chase phantom alerts on healthy traffic.
        $this->seedActiveCover();
        $account = ProxyAccount::factory()->create();
        $account->setCleartextPassword('s3cr3t');
        $account->save();

        $response = $this->get('/api/v1/subscription/'.$account->subscriptionToken());
        $this->assertSame(200, $response->status());
        $this->assertSame('application/json', $response->headers->get('Content-Type'));

        $this->assertEmpty(
            $this->loggedMatching('subscription.fallthrough'),
            'happy path must NOT log fall-through: '
            .json_encode($this->loggedMatching('subscription.fallthrough')),
        );
    }
}
