<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\FakeWebsite;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// Round-27 model lifecycle. Pins the contract on
// FakeWebsite::saved (the booted event handler in
// panel/app/Models/FakeWebsite.php): at most one row may have
// is_active=true at any time. The handler enforces this by
// deactivating all other active rows inside a transaction with
// lockForUpdate when an activation is saved.
//
// Pre-v0.0.16 the deactivation ran without locking, leaving a
// race window where two concurrent activations could BOTH
// commit is_active=true. FakeSiteController::show fell through
// to whichever sorted first by id — visible nondeterminism in
// the cover site.
//
// The lockForUpdate fix is non-trivial (savepoint-aware nested
// transaction inside the saved listener). A future "simplify"
// refactor could strip the lockForUpdate or the surrounding
// transaction without breaking any existing test, restoring
// the race silently. These tests pin the invariant.
class FakeWebsiteSingleActiveTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function activating_a_second_site_deactivates_the_first(): void
    {
        $a = FakeWebsite::factory()->active()->create(['name' => 'site-a']);
        $b = FakeWebsite::factory()->active()->create(['name' => 'site-b']);

        $a->refresh();
        $b->refresh();

        $this->assertFalse(
            $a->is_active,
            'site-a must be auto-deactivated when site-b is activated; '
            .'a future strip of the saved listener\'s deactivation block '
            .'would let both rows stay active and reintroduce the '
            .'pre-v0.0.16 cover-site nondeterminism',
        );
        $this->assertTrue($b->is_active);
        $this->assertSame(1, FakeWebsite::where('is_active', true)->count());
    }

    #[Test]
    public function only_one_active_after_a_chain_of_activations(): void
    {
        // Stress the listener with a longer sequence — each
        // activation must deactivate ALL prior ones, not just the
        // most recent. A bug that only deactivates the
        // last-activated row (e.g. tracking via a "currently
        // active id" instead of querying by `is_active = true`)
        // would let intermediate rows stay active.
        $rows = collect(range(1, 5))->map(
            fn ($i) => FakeWebsite::factory()->active()->create(['name' => "site-$i"]),
        )->all();

        foreach ($rows as $r) {
            $r->refresh();
        }
        $this->assertSame(
            1,
            FakeWebsite::where('is_active', true)->count(),
            'after 5 sequential activations, exactly ONE row may be active',
        );
        $this->assertTrue(
            $rows[4]->is_active,
            'the LAST activation must be the one that wins (operator-intent)',
        );
    }

    #[Test]
    public function deactivating_the_only_active_site_leaves_zero_active(): void
    {
        // Saving with is_active=false must NOT trigger the
        // deactivation cascade (the listener early-returns on
        // !is_active). Operator intent: zero active sites is a
        // valid state — FakeSiteController falls back to
        // FakeWebsite::orderBy('id')->first() in that case.
        $a = FakeWebsite::factory()->active()->create();

        $a->is_active = false;
        $a->save();

        $this->assertSame(0, FakeWebsite::where('is_active', true)->count());
    }

    #[Test]
    public function saving_an_inactive_site_does_not_disturb_the_active_one(): void
    {
        // A common operator action: edit the title/body of a
        // dormant fake site without activating it. The listener
        // must early-return on !is_active so it doesn't
        // accidentally deactivate the currently-active site.
        $active = FakeWebsite::factory()->active()->create(['name' => 'live']);
        $dormant = FakeWebsite::factory()->create(['is_active' => false, 'name' => 'draft']);

        $dormant->name = 'draft-edited';
        $dormant->save();

        $active->refresh();
        $this->assertTrue(
            $active->is_active,
            'editing a non-active row must not disturb the live cover site',
        );
    }
}
