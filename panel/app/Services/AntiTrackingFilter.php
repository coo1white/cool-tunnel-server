<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\ServerConfig;

// Helper for the Filament Anti-Tracking page and for the docs:
// returns the currently-active set of mitigations as a structured
// array, plus prose descriptions of each. Doesn't *do* any filtering
// itself — the actual header sanitization happens at the Caddy layer
// via hide_ip / hide_via, which are on by default.

final class AntiTrackingFilter
{
    public const FEATURES = [
        'hide_ip' => [
            'label' => 'Hide client IP',
            'desc'  => 'Strip Forwarded, X-Forwarded-For, and X-Real-IP from outgoing requests so the upstream cannot see who is connecting to the proxy.',
        ],
        'hide_via' => [
            'label' => 'Hide Via header',
            'desc'  => 'Strip the Via header that would otherwise reveal that the request transited a proxy at all.',
        ],
        'probe_resistance' => [
            'label' => 'Probe resistance',
            'desc'  => 'Unauthenticated CONNECT is indistinguishable from a wrong-password attempt. The fake site is served instead of any proxy fingerprint.',
        ],
        'doh_resolver' => [
            'label' => 'DNS over HTTPS for Caddy',
            'desc'  => 'Caddy uses a DoH resolver for ACME and any other lookups it does itself. Stops the host recursive resolver from seeing those names.',
        ],
        'http3' => [
            'label' => 'HTTP/3 (QUIC)',
            'desc'  => 'Listens on UDP/443 in addition to TCP/443. QUIC connections are harder to fingerprint and selectively throttle than TCP/443.',
        ],
    ];

    public function status(): array
    {
        $cfg = ServerConfig::current();
        return [
            'hide_ip'          => (bool) $cfg->anti_tracking_hide_ip,
            'hide_via'         => (bool) $cfg->anti_tracking_hide_via,
            'probe_resistance' => (bool) $cfg->anti_tracking_probe_resistance,
            'doh_resolver'     => (string) $cfg->anti_tracking_doh_resolver !== '',
            'http3'            => (bool) $cfg->http3_enabled,
        ];
    }
}
