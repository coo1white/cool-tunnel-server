<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

// Browser-side security headers for the Filament admin panel.
//
// Today the panel binds to 127.0.0.1:9000 and is reached through
// an SSH-local-port-forward (the deferred R1-1 / R1-2 SNI router
// will eventually expose it publicly under the same domain as the
// proxy itself). Either way, the browser making the request is
// the operator's, so the same browser-side hardening that any
// admin-panel deserves applies here:
//
//   X-Frame-Options: DENY
//     Disallow embedding /admin/* in an iframe — defeats clickjacking
//     attempts where a malicious site frames the panel and tricks
//     the operator into clicking through actions.
//
//   X-Content-Type-Options: nosniff
//     Browsers don't try to "guess" content type from contents.
//     Necessary for any HTML-serving endpoint that might also
//     return JSON / SVG / other types.
//
//   Referrer-Policy: strict-origin-when-cross-origin
//     Outgoing links from /admin (links in fake-website previews,
//     external docs links) don't leak the full /admin URL — only
//     the origin, only when transitioning origins.
//
//   Permissions-Policy: camera=(), microphone=(), geolocation=()
//     Belt-and-braces denial of features the panel doesn't use.
//     Stops a future XSS from accessing them silently.
//
//   Cache-Control: no-store, must-revalidate
//     The admin panel's authenticated responses MUST NOT be cached
//     by the browser or any intermediary — a "back" navigation to
//     /admin after logout otherwise shows a stale (and possibly
//     credential-leaking) page from cache. The cover-site path
//     (FakeSiteController) sets its own Cache-Control: public
//     because the cover SHOULD be cached; this middleware runs
//     only on the panel routes (registered in AdminPanelProvider's
//     middleware stack), so the two policies coexist.
//
//   Strict-Transport-Security: max-age=63072000; includeSubDomains
//     Two years HSTS, applies to all subdomains. Only meaningful
//     when the panel is reached over HTTPS (post-R1 deferred), but
//     setting it now is harmless and forward-compatible.
//
// (v0.0.18 — Loop-4 self-check.)

class SecurityHeaders
{
    public function handle(Request $request, Closure $next): Response
    {
        /** @var Response $response */
        $response = $next($request);

        $response->headers->set('X-Frame-Options', 'DENY');
        $response->headers->set('X-Content-Type-Options', 'nosniff');
        $response->headers->set('Referrer-Policy', 'strict-origin-when-cross-origin');
        $response->headers->set(
            'Permissions-Policy',
            'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        );
        $response->headers->set('Cache-Control', 'no-store, must-revalidate');
        $response->headers->set(
            'Strict-Transport-Security',
            'max-age=63072000; includeSubDomains',
        );

        return $response;
    }
}
