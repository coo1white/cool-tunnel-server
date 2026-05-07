<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\FakeWebsite;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

// Catch-all controller for any non-/admin request that comes through
// Caddy's fall-through. We render whichever fake site is currently
// active (or the default "minimal blog" template if none is set).

class FakeSiteController extends Controller
{
    /**
     * Active-probing alarm threshold (v0.0.57 china-readiness).
     *
     * Cover-site fall-through hits per source IP per minute that
     * trigger a single `probe.detected` log line. Real human
     * traffic to a personal blog rarely produces > 30 distinct
     * URL hits/min from one IP; sustained spikes from a single
     * source are characteristic of an active scanner / GFW probe
     * sweep walking URL space. Lower threshold = more false
     * alarms; higher = slower detection. 30/min is a balanced
     * starting point — operators can tune via Cache::tags or by
     * editing this constant.
     */
    private const PROBE_ALARM_RATE_PER_MIN = 30;

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
     * Active-probing detector (v0.0.57 china-readiness).
     *
     * Real human traffic to a personal blog cover-site distributes
     * across many source IPs at low rates. An active scanner — GFW
     * probe sweep, automated bot, mass-target censor — concentrates
     * many distinct URL hits at one source IP within a short
     * window. We count fall-through hits per (source-ip, minute) in
     * the cache and emit a structured `probe.detected` log line
     * when the rate crosses the threshold.
     *
     * Why a log line, not a block: the cover-site invariant is the
     * actual defence — every fall-through returns byte-identical
     * cover bytes, so the probe gets nothing useful regardless of
     * volume. The log line is purely an early-warning signal so the
     * operator knows their server has been spotted and may want to
     * rotate the domain. Blocking source IPs would be visible to
     * the censor (a sudden 503 from a previously-200 host) and is
     * a strictly worse signal than letting them keep getting cover
     * bytes.
     *
     * Cache key bucket = (ip, year-month-day-hour-minute). Minute
     * boundaries reset the counter; sustained probes accumulate
     * within each minute and trip the alarm fast.
     *
     * NOT instrumented on the response itself — must NOT change
     * status / headers / body of the cover response (the invariant
     * test enforces this).
     */
    private function maybeAlarmOnRapidFallThrough(Request $request): void
    {
        $ip = $request->ip() ?? 'unknown';
        $bucket = 'probe:'.$ip.':'.now()->format('YmdHi');

        // Cache::increment is atomic in Redis (the v0.0.x cache
        // store). The `add` first-set ensures the bucket exists at
        // 0 with a 90-second TTL before we increment, so the key
        // self-reaps after the minute it covers; we don't need a
        // sweep cron.
        Cache::add($bucket, 0, 90);
        $count = Cache::increment($bucket);

        // Log exactly once per (ip, minute) — when crossing the
        // threshold. Pre-fix, every hit past threshold logged,
        // producing noise spikes that drowned legitimate alerts.
        if ($count === self::PROBE_ALARM_RATE_PER_MIN) {
            Log::warning('probe.detected', [
                'source_ip' => $ip,
                'rate_per_min' => $count,
                'path' => $request->path(),
                'user_agent' => substr((string) $request->userAgent(), 0, 200),
                'note' => 'cover-site fall-through rate crossed threshold; possible active probing',
            ]);
        }
    }
}
