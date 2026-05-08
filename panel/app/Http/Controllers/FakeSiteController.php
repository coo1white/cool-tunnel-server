<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\FakeWebsite;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\RateLimiter;

// Catch-all controller for any non-/admin request that comes through
// Caddy's fall-through. We render whichever fake site is currently
// active (or the default "minimal blog" template if none is set).

class FakeSiteController extends Controller
{
    /**
     * Active-probing alarm threshold.
     *
     * Cover-site fall-through hits per source IP per minute that
     * trip a single `probe.detected` log line. Real human traffic
     * to a personal blog rarely produces > 30 distinct URL hits/min
     * from one IP; sustained spikes from a single source are
     * characteristic of an active scanner / GFW probe sweep walking
     * URL space. Lower threshold = more false alarms; higher =
     * slower detection.
     */
    private const PROBE_ALARM_RATE_PER_MIN = 30;

    /**
     * RateLimiter decay window. The fall-through counter resets
     * after this many seconds of no hits, so an attacker who
     * paces probes outside the window slips under the radar — a
     * 60-second window matches the threshold's per-minute units.
     */
    private const PROBE_DECAY_SEC = 60;

    public function show(Request $request): Response
    {
        $this->maybeAlarmOnRapidFallThrough($request);

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

    /**
     * Active-probing detector — emits `probe.detected` once per
     * (source-ip, decay-window) when fall-through hit rate from
     * one IP crosses PROBE_ALARM_RATE_PER_MIN.
     *
     * Why a log line, not a block: the cover-site invariant is
     * the actual defence — every fall-through returns byte-
     * identical cover bytes, so the probe gets nothing useful
     * regardless of volume. The log is an early-warning signal so
     * the operator knows their server has been spotted and may
     * want to rotate the domain. Blocking source IPs would be
     * visible to the censor (a sudden 503 from a previously-200
     * host) and is a strictly worse signal than letting them keep
     * getting cover bytes.
     *
     * Uses the framework's RateLimiter facade — same primitive
     * SubscriptionController uses for its per-minute rate limit.
     * `hit()` is atomic across cache stores; the `:alarmed`
     * sentinel collapses the "alarm fires once per (ip, decay-
     * window)" property under sequential traffic. Raw `===`
     * against the count (the original v0.0.57 implementation)
     * would silently miss the alarm when concurrent increments
     * take it from N-1 → N+1; the `tooManyAttempts(>=N)` +
     * sentinel pair covers that.
     *
     * Caveat: the sentinel check / `hit` pair is not single-
     * statement atomic, so two concurrent requests that race past
     * the threshold can both observe `attempts=0` on the sentinel
     * and both log. Worst-case duplicate-log spread is one per
     * crossing under heavy concurrent probing — small enough
     * that fixing it would mean either a Redis-only Lua script
     * or moving to a database-locking primitive, neither worth
     * the complexity for an early-warning signal.
     *
     * If `$request->ip()` is null (proxy misconfiguration / unit
     * test) we skip the path entirely rather than collapsing all
     * unidentified clients into one shared bucket where they'd
     * trip spurious alarms together.
     *
     * NOT instrumented on the response itself — must not change
     * status / headers / body of the cover response (the
     * invariant test enforces this).
     */
    private function maybeAlarmOnRapidFallThrough(Request $request): void
    {
        $ip = $request->ip();
        if ($ip === null || $ip === '') {
            return;
        }

        // RateLimiter ordering note (round-26 cohesion audit): this is
        // HIT-THEN-CHECK, deliberately distinct from the CHECK-THEN-HIT
        // pattern in SubscriptionController. With max=PROBE_ALARM_RATE_PER_MIN
        // (30), the 30th cover-site fall-through inside the decay
        // window triggers the alarm — it counts itself BEFORE the
        // threshold check. SubscriptionController instead checks
        // before hitting (so the 60th request passes and the 61st is
        // blocked). Don't unify the two — see SubscriptionController
        // for the rationale; round-26 boundary test pins both shapes.
        $key = 'probe:'.$ip;
        RateLimiter::hit($key, self::PROBE_DECAY_SEC);

        if (! RateLimiter::tooManyAttempts($key, self::PROBE_ALARM_RATE_PER_MIN)) {
            return;
        }

        // Sentinel — fire the log line at most once per
        // (ip, decay-window). Without this, every hit past the
        // threshold would log, producing noise spikes that
        // drown the actual alert.
        $sentinel = 'probe:alarmed:'.$ip;
        if (RateLimiter::tooManyAttempts($sentinel, 1)) {
            return;
        }
        RateLimiter::hit($sentinel, self::PROBE_DECAY_SEC);

        Log::warning('probe.detected', [
            'source_ip' => $ip,
            'rate_per_min' => RateLimiter::attempts($key),
            'path' => $request->path(),
            'user_agent' => substr((string) $request->userAgent(), 0, 200),
            'note' => 'cover-site fall-through rate crossed threshold; possible active probing',
        ]);
    }
}
