<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\ProxyAccount;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// Round-15 idempotency / replay-safety: the subscription token
// the operator hands a user MUST be a pure function of (account_id,
// APP_KEY). If a future change accidentally mixed in a nonce, a
// timestamp, or a per-process random, every regenerate-token URL
// would silently change on every refresh of the panel — clients
// holding bookmarked URLs would all break at once with no panel-
// side error.
//
// The token is documented as deterministic in
// SubscriptionController::resolve()'s comment block; this test
// pins that contract at the model layer so a refactor of
// subscriptionToken() that breaks it fails CI before deploy.
class SubscriptionTokenDeterminismTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function subscription_token_is_pure_in_account_id_and_app_key(): void
    {
        $account = ProxyAccount::factory()->create();
        $first = $account->subscriptionToken();
        $second = $account->subscriptionToken();
        $third = ProxyAccount::find($account->id)->subscriptionToken();

        $this->assertNotSame('', $first, 'token must not be empty under a configured APP_KEY');
        $this->assertSame(
            $first,
            $second,
            'two calls on the same instance must return the same token — '
            .'a difference means a non-deterministic input snuck in '
            .'(nonce, timestamp, per-process random)',
        );
        $this->assertSame(
            $first,
            $third,
            'a fresh model load from DB must produce the same token — '
            .'a difference means the token depends on in-memory model '
            .'state that is not part of the (id, APP_KEY) input set',
        );
    }

    #[Test]
    public function subscription_token_changes_when_app_key_rotates(): void
    {
        // The flip-side invariant: an APP_KEY rotation MUST
        // invalidate every existing token (reasoning is in the
        // panel/.env.example warning block — round-10).
        $account = ProxyAccount::factory()->create();
        $beforeRotation = $account->subscriptionToken();

        $newKey = 'base64:'.base64_encode(random_bytes(32));
        config(['app.key' => $newKey]);
        $afterRotation = $account->subscriptionToken();

        $this->assertNotSame(
            $beforeRotation,
            $afterRotation,
            'APP_KEY rotation must produce a different token — '
            .'if the same token survives rotation, the APP_KEY is '
            .'not actually being mixed into the HMAC',
        );
    }

    #[Test]
    public function subscription_token_returns_empty_when_app_key_is_blank(): void
    {
        // Hard-fail behaviour: with no APP_KEY there is no key
        // material to HMAC with, so token issuance must refuse
        // (returning '' here causes subscriptionUrl() to return
        // null, which Filament uses as the "Cannot generate URL"
        // signal in the action).
        $account = ProxyAccount::factory()->create();
        config(['app.key' => '']);
        $this->assertSame(
            '',
            $account->subscriptionToken(),
            'empty APP_KEY must produce an empty token, not a '
            .'token signed with an empty key (which would be a '
            .'trivially-forgeable HMAC)',
        );
    }
}
