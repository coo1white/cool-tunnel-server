<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\FakeWebsite;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

// Catch-all controller for any non-/admin request that comes through
// Caddy's fall-through. We render whichever fake site is currently
// active (or the default "minimal blog" template if none is set).

class FakeSiteController extends Controller
{
    public function show(Request $request): Response
    {
        $site = FakeWebsite::active() ?? FakeWebsite::orderBy('id')->first();

        // Cache fairly aggressively — the cover site changes rarely
        // and we want probe traffic to look like a normal static-ish
        // site (Cache-Control: public). The panel busts this cache
        // by versioning rendered output via etag on save.
        //
        // PHP's string-interpolation parser does not accept the
        // null-coalescing operator inside `{...}`, so resolve the
        // template name first.
        // @phpstan-ignore-next-line nullsafe.neverNull ($site is null when FakeWebsite table has no rows)
        $template = $site?->template ?? 'blog';
        $body = view("fake-sites.{$template}", [
            'site' => $site,
            'path' => trim($request->path(), '/'),
        ])->render();

        // Deterministic ETag — the rendered HTML for a given active
        // FakeWebsite row is byte-stable across requests, so the
        // ETag derived from sha256(body) is stable too. A static-
        // looking site with `Cache-Control: public, max-age=3600`
        // but NO validator headers (ETag / Last-Modified) is
        // unusual; nginx/apache both emit ETag by default for
        // static files. Adding it here removes a probe-side
        // distinguisher between "real static site" and "cover
        // site rendered by a Laravel app". Conditional-GET
        // (If-None-Match) is honoured so legitimate clients
        // benefit from 304s. (v0.0.14 anti-censorship hardening.)
        $etag = '"'.substr(hash('sha256', $body), 0, 16).'"';

        if ($request->header('If-None-Match') === $etag) {
            return response('', 304)
                ->header('Cache-Control', 'public, max-age=3600')
                ->header('ETag', $etag);
        }

        return response($body, 200)
            ->header('Cache-Control', 'public, max-age=3600')
            ->header('Content-Type', 'text/html; charset=utf-8')
            ->header('ETag', $etag);
    }
}
