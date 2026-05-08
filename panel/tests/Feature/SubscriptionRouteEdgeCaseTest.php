<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\FakeWebsite;
use App\Models\ServerConfig;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

// Round-20 edge-case input handling. The cover-site invariant
// (round-5 + later hardenings) requires that ANY input shape on
// the subscription endpoint — well-formed token, malformed token,
// path-traversal attempt, base64 padding chars, query strings,
// extra path segments, etc. — return bytes byte-identical to a
// vanilla unknown-path probe.
//
// The protection chain is two layers deep:
//   1. The route's `where('token', '[A-Za-z0-9_-]+')` constraint
//      rejects any path segment that isn't strict base64url.
//      A non-matching segment produces NotFoundHttpException.
//   2. The bootstrap/app.php exception handler catches that on
//      non-admin paths and re-renders FakeSiteController.
//
// Either layer alone is insufficient: the route constraint
// without the catch would bubble a Laravel-branded 404 page
// (a censor distinguisher); the catch without the constraint
// would let downstream code (the controller, the HMAC parser,
// base64 decoders) see arbitrary bytes.
//
// This test exercises a battery of malformed inputs and asserts
// each one returns the cover-site bytes. If a future change
// loosens either layer (a route-regex tweak, an exception-handler
// scope shrink), one of these assertions fails first.
class SubscriptionRouteEdgeCaseTest extends TestCase
{
    use RefreshDatabase;

    private function seedActiveCover(): void
    {
        ServerConfig::factory()->create();
        FakeWebsite::factory()->active()->create();
    }

    private function coverSiteBaseline()
    {
        return $this->get('/cover-baseline-'.bin2hex(random_bytes(4)));
    }

    /** @return iterable<array{0: string, 1: string}> */
    public static function malformedTokenProvider(): iterable
    {
        // Each entry: [test-label, raw token after `/api/v1/subscription/`].
        // The HTTP request layer in PHPUnit will URL-encode special chars
        // automatically; we want each test to exercise both the regex
        // boundary AND any URL-decoder gotchas.
        return [
            'token with dot' => ['malformed.token'],
            'token with slash' => ['path/traversal'],
            'token with plus' => ['plus+sign'],
            'token with equals (base64 padding)' => ['padded='],
            'token with percent-encoded null' => ['null%00byte'],
            // CR/LF/TAB tokens are rejected by Symfony's URI parser
            // BEFORE reaching the app — verified empirically;
            // BadRequestException fires at request construction.
            // That's a correctness layer the app gets for free; not
            // exercised here because the failure mode is on the
            // test client side, not the SUT.
            'all-uppercase short' => ['ABC'],
            'numeric only' => ['12345'],
            'leading hyphen' => ['-leading'],
            'trailing hyphen' => ['trailing-'],
            'underscore only' => ['___'],
            'extreme length (1000 valid chars)' => [str_repeat('A', 1000)],
        ];
    }

    #[Test]
    #[DataProvider('malformedTokenProvider')]
    public function malformed_token_returns_cover_site_bytes(string $token): void
    {
        $this->seedActiveCover();
        $cover = $this->coverSiteBaseline();
        $sub = $this->get('/api/v1/subscription/'.$token);

        $this->assertSame(
            $cover->status(),
            $sub->status(),
            "status must match cover for token=`{$token}`",
        );
        $this->assertSame(
            $cover->headers->get('Content-Type'),
            $sub->headers->get('Content-Type'),
            "Content-Type must match cover for token=`{$token}`",
        );
        $this->assertSame(
            $cover->getContent(),
            $sub->getContent(),
            "body bytes must match cover for token=`{$token}` — "
            ."either the route regex now accepts characters it shouldn't, "
            .'or the exception handler scope shrunk and a Laravel-branded '
            .'error page is leaking instead of falling through to cover-site',
        );
    }

    #[Test]
    public function subscription_path_with_extra_segments_returns_cover_site(): void
    {
        // /api/v1/subscription/<token>/extra is not the route shape the
        // controller registered; the catch-all `/{any}` excludes paths
        // starting with `api`. So the path matches no route and the
        // exception handler falls through to FakeSiteController.
        // Exercises the second layer of the protection chain on its own.
        $this->seedActiveCover();
        $cover = $this->coverSiteBaseline();
        $sub = $this->get('/api/v1/subscription/some-token/extra/segments');
        $this->assertSame($cover->getContent(), $sub->getContent());
    }

    #[Test]
    public function subscription_path_with_query_string_still_returns_cover_site_for_unknown(): void
    {
        // Laravel routes match on PATH, not QUERY. So
        // /api/v1/subscription/this-token-does-not-exist?nonce=123
        // hits SubscriptionController::show with $token =
        // 'this-token-does-not-exist'; the resolve fails; cover-site
        // returned by the controller's null-account branch (round-12).
        $this->seedActiveCover();
        $cover = $this->coverSiteBaseline();
        $sub = $this->get('/api/v1/subscription/this-token-does-not-exist?nonce=123&extra=foo');
        $this->assertSame($cover->getContent(), $sub->getContent());
    }
}
