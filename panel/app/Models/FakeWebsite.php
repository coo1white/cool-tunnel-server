<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

class FakeWebsite extends Model
{
    use HasFactory;

    protected $fillable = [
        'slug', 'name', 'template', 'title', 'tagline',
        'payload', 'is_active',
    ];

    protected function casts(): array
    {
        return [
            'payload' => 'array',
            'is_active' => 'boolean',
        ];
    }

    public static function active(): ?self
    {
        return static::where('is_active', true)->first();
    }

    protected static function booted(): void
    {
        // Only one fake site can be active at a time.
        //
        // Pre-v0.0.16 the deactivation of all-others ran without a
        // transaction or row lock, so two admins concurrently
        // activating different rows produced an interleaving like:
        //
        //   T0  admin-A: row A.is_active = true (committed)
        //   T1  admin-B: row B.is_active = true (committed)
        //   T2  saved-A: UPDATE WHERE id != A AND is_active=true → sets B inactive
        //   T3  saved-B: UPDATE WHERE id != B AND is_active=true → sees A inactive
        //
        // — except T2/T3 can swap, and the SAVED hooks fire before
        // either UPDATE commits. Worst case both rows end up active;
        // FakeSiteController::show falls through to whichever sorts
        // first by id, producing visible nondeterminism in the cover
        // site. The `singbox:render` path doesn't care about
        // FakeWebsite, so the *proxy* still works — but the cover
        // site shape is the entire point of the table.
        //
        // Wrap the deactivation in a transaction with `lockForUpdate`
        // on the rows we're about to flip. Concurrent activations
        // serialise: each transaction waits for the prior one's
        // locks to release, then re-reads, then commits its own
        // "everyone-else-inactive" view. Last-writer-wins, which is
        // the operator-intent semantic the form already implies.
        static::saved(function (self $site): void {
            if (! $site->is_active) {
                return;
            }
            DB::transaction(function () use ($site): void {
                static::where('id', '!=', $site->id)
                    ->where('is_active', true)
                    ->lockForUpdate()
                    ->update(['is_active' => false]);
            });
        });
    }
}
