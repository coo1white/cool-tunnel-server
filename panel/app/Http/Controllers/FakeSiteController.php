<?php

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
        $body = view("fake-sites.{$site?->template ?? 'blog'}", [
            'site' => $site,
            'path' => trim($request->path(), '/'),
        ])->render();

        return response($body, 200)
            ->header('Cache-Control', 'public, max-age=3600')
            ->header('Content-Type', 'text/html; charset=utf-8');
    }
}
