<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\ProxyAccount;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// Round-15 idempotency / replay-safety, upgraded for revocation:
// the subscription token the operator hands a user MUST be stable
// across reads, but it must also be revocable without rotating the
// entire panel APP_KEY. The token is therefore a pure function of
// (account_id, subscription_secret, APP_KEY).
//
// The token is documented as deterministic in
// SubscriptionController::resolve()'s comment block; this test
// pins that contract at the model layer so a refactor of
// subscriptionToken() that breaks it fails CI before deploy.
class SubscriptionTokenDeterminismTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function subscription_token_is_stable_for_the_same_row_secret_and_app_key(): void
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
            .'state that is not persisted on the row',
        );
    }

    #[Test]
    public function subscription_token_changes_when_row_secret_rotates(): void
    {
        $account = ProxyAccount::factory()->create();
        $beforeRotation = $account->subscriptionToken();

        $account->rotateSubscriptionSecret();
        $account->save();

        $this->assertNotSame(
            $beforeRotation,
            $account->subscriptionToken(),
            'rotating the per-row subscription secret must revoke old URLs',
        );
    }

    #[Test]
    public function regenerating_uuid_also_revokes_subscription_url(): void
    {
        $account = ProxyAccount::factory()->create();
        $beforeRotation = $account->subscriptionToken();

        $account->regenerateUuid();
        $account->save();

        $this->assertNotSame(
            $beforeRotation,
            $account->subscriptionToken(),
            'a new UUID must not remain fetchable through a leaked old subscription URL',
        );
    }

    #[Test]
    public function legacy_rows_without_subscription_secret_keep_existing_token_shape(): void
    {
        $account = ProxyAccount::factory()->create();
        $account->subscription_secret = null;
        $account->saveQuietly();

        $key = (string) config('app.key');
        $legacySig = hash_hmac('sha256', (string) $account->id, $key);
        $legacyToken = rtrim(strtr(base64_encode($account->id.'.'.$legacySig), '+/', '-_'), '=');

        $this->assertSame($legacyToken, $account->subscriptionToken());
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
