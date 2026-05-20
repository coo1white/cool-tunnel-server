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
// v0.4.0: log code renames (cleartext_decrypt_failed → uuid_missing)
// and a new fallthrough branch when ServerConfig.reality_public_key
// is empty.
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

        $this->get('/api/v1/subscription/'.$account->subscriptionToken());

        $hits = $this->loggedMatching('subscription.fallthrough.account_disabled');
        $this->assertCount(1, $hits, 'disabled account must log exactly once per request');
        $this->assertSame('warning', $hits[0]['level']);
        $this->assertSame($account->id, $hits[0]['context']['account_id']);
        // Privacy invariant (CONTRIBUTING.md): usernames are NEVER logged.
        // account_id is sufficient for operator DB-lookup.
        $this->assertArrayNotHasKey(
            'username',
            $hits[0]['context'],
            'username MUST NOT appear in subscription-fallthrough logs',
        );
    }

    #[Test]
    public function missing_uuid_logs_critical_with_account_id(): void
    {
        // Active account, working token, but the uuid column is
        // empty. The booted() `creating` hook on ProxyAccount auto-
        // seeds a UUID, so this branch only fires for a corrupt
        // direct-DB row OR a legacy migration that didn't run. It's
        // the operator-must-fix-NOW scenario; CRITICAL is the right
        // level so dashboards alert.
        $this->seedActiveCover();
        $account = ProxyAccount::factory()->create();
        // Bypass the creating-hook by zeroing the column directly.
        $account->uuid = '';
        $account->saveQuietly();

        $this->get('/api/v1/subscription/'.$account->subscriptionToken());

        $hits = $this->loggedMatching('subscription.fallthrough.uuid_missing');
        $this->assertCount(1, $hits, 'missing uuid must log exactly once per request');
        $this->assertSame('critical', $hits[0]['level']);
        $this->assertSame($account->id, $hits[0]['context']['account_id']);
        // Privacy invariant (CONTRIBUTING.md): usernames are NEVER logged.
        $this->assertArrayNotHasKey(
            'username',
            $hits[0]['context'],
            'username MUST NOT appear in subscription-fallthrough logs',
        );
    }

    #[Test]
    public function missing_reality_public_key_logs_critical_with_account_id(): void
    {
        // Server-side mis-configuration: a healthy account but the
        // ServerConfig row has no Reality public key (operator never
        // ran first-boot SingboxBootstrap, or the column got nulled).
        // A v3.0.0 client receiving a manifest without reality.public_key
        // would have nothing to plug into its sing-box outbound and
        // fail at handshake time — fall-through to cover-site bytes
        // surfaces the failure as "subscription URL not working" the
        // operator can debug.
        ServerConfig::factory()->create(['reality_public_key' => '']);
        FakeWebsite::factory()->active()->create();
        $account = ProxyAccount::factory()->create();

        $this->get('/api/v1/subscription/'.$account->subscriptionToken());

        $hits = $this->loggedMatching('subscription.fallthrough.reality_public_key_missing');
        $this->assertCount(1, $hits, 'missing reality_public_key must log exactly once per request');
        $this->assertSame('critical', $hits[0]['level']);
        $this->assertSame($account->id, $hits[0]['context']['account_id']);
    }

    #[Test]
    public function malformed_reality_dest_host_logs_critical_with_account_id(): void
    {
        ServerConfig::factory()->create(['reality_dest_host' => 'https://']);
        FakeWebsite::factory()->active()->create();
        $account = ProxyAccount::factory()->create();

        $this->get('/api/v1/subscription/'.$account->subscriptionToken());

        $hits = $this->loggedMatching('subscription.fallthrough.reality_dest_host_invalid');
        $this->assertCount(1, $hits, 'invalid reality_dest_host must log exactly once per request');
        $this->assertSame('critical', $hits[0]['level']);
        $this->assertSame($account->id, $hits[0]['context']['account_id']);
    }

    #[Test]
    public function happy_path_emits_no_fall_through_logs(): void
    {
        // Sanity: a successful manifest serve must NOT emit any
        // subscription.fallthrough.* log. If it did, the operator
        // would chase phantom alerts on healthy traffic.
        $this->seedActiveCover();
        $account = ProxyAccount::factory()->create();

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
