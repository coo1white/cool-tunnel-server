// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/reality-clock.ts — Reality auth-window clock health.
//
// Reality rejects handshakes whose client/server clocks differ beyond
// tls.reality.max_time_difference. This helper gives doctor/readiness/
// ballast one shared interpretation of the live server clock.

import { $, capture } from "./sh";

export type RealityClockStatus = "pass" | "warn" | "fail";

export interface RealityClockReport {
    status: RealityClockStatus;
    detail: string;
    hint?: string;
    skewMs: number | null;
    maxTimeDifferenceMs: number;
    ntpSynchronized: boolean | null;
    source: string | null;
}

const DEFAULT_MAX_TIME_DIFFERENCE_MS = 60_000;
const CLOCK_HINT =
    "timedatectl set-ntp true; systemctl restart systemd-timesyncd 2>/dev/null || true; docker compose restart singbox";

export function parseDurationMs(raw: string | null | undefined): number | null {
    if (!raw) return null;
    const input = raw.trim();
    if (!input) return null;

    let total = 0;
    let consumed = "";
    const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
    for (;;) {
        const m = re.exec(input);
        if (!m) break;
        const n = Number(m[1]);
        const unit = m[2];
        if (!Number.isFinite(n)) return null;
        consumed += m[0];
        if (unit === "ms") total += n;
        else if (unit === "s") total += n * 1000;
        else if (unit === "m") total += n * 60_000;
        else if (unit === "h") total += n * 3_600_000;
    }

    if (consumed !== input || total <= 0) return null;
    return Math.round(total);
}

export function findRealityMaxTimeDifference(configText: string): string | null {
    try {
        const cfg = JSON.parse(configText) as {
            inbounds?: Array<{ tls?: { reality?: { max_time_difference?: unknown } } }>;
        };
        for (const inbound of cfg.inbounds ?? []) {
            const value = inbound.tls?.reality?.max_time_difference;
            if (typeof value === "string" && value.trim()) return value.trim();
        }
    } catch {
        return null;
    }
    return null;
}

export function parseHttpDateHeader(headers: string): number | null {
    const m = headers.match(/^date:\s*(.+?)\s*$/im);
    if (!m || !m[1]) return null;
    const ms = Date.parse(m[1].trim());
    return Number.isFinite(ms) ? ms : null;
}

export function formatDurationMs(ms: number): string {
    const abs = Math.abs(ms);
    if (abs >= 60_000 && abs % 60_000 === 0) return `${Math.round(ms / 60_000)}m`;
    if (abs >= 1000) return `${Math.round(ms / 1000)}s`;
    return `${Math.round(ms)}ms`;
}

export function classifyRealityClock(input: {
    skewMs: number | null;
    maxTimeDifferenceMs: number;
    ntpSynchronized: boolean | null;
    source: string | null;
}): RealityClockReport {
    const budget = input.maxTimeDifferenceMs > 0 ? input.maxTimeDifferenceMs : DEFAULT_MAX_TIME_DIFFERENCE_MS;
    const budgetText = formatDurationMs(budget);
    const sourceText = input.source ? ` via ${input.source}` : "";
    const ntpText =
        input.ntpSynchronized === true
            ? "NTP synchronized"
            : input.ntpSynchronized === false
              ? "NTP not synchronized"
              : "NTP state unknown";

    if (input.skewMs !== null) {
        const absSkew = Math.abs(input.skewMs);
        const skewText = formatDurationMs(absSkew);
        if (absSkew >= budget) {
            return {
                status: "fail",
                detail: `UTC skew ${skewText}${sourceText} exceeds Reality budget ${budgetText}; ${ntpText}`,
                hint: CLOCK_HINT,
                skewMs: input.skewMs,
                maxTimeDifferenceMs: budget,
                ntpSynchronized: input.ntpSynchronized,
                source: input.source,
            };
        }

        if (input.ntpSynchronized === false) {
            return {
                status: "fail",
                detail: `UTC skew ${skewText}${sourceText} is inside Reality budget ${budgetText}, but ${ntpText}`,
                hint: CLOCK_HINT,
                skewMs: input.skewMs,
                maxTimeDifferenceMs: budget,
                ntpSynchronized: input.ntpSynchronized,
                source: input.source,
            };
        }

        const warnAt = Math.max(5_000, Math.min(30_000, Math.floor(budget / 2)));
        if (absSkew >= warnAt) {
            return {
                status: "warn",
                detail: `UTC skew ${skewText}${sourceText} is close to Reality budget ${budgetText}; ${ntpText}`,
                hint: CLOCK_HINT,
                skewMs: input.skewMs,
                maxTimeDifferenceMs: budget,
                ntpSynchronized: input.ntpSynchronized,
                source: input.source,
            };
        }

        return {
            status: "pass",
            detail: `UTC skew ${skewText}${sourceText} within Reality budget ${budgetText}; ${ntpText}`,
            skewMs: input.skewMs,
            maxTimeDifferenceMs: budget,
            ntpSynchronized: input.ntpSynchronized,
            source: input.source,
        };
    }

    if (input.ntpSynchronized === true) {
        return {
            status: "pass",
            detail: `NTP synchronized; could not sample external UTC, Reality budget ${budgetText}`,
            skewMs: null,
            maxTimeDifferenceMs: budget,
            ntpSynchronized: input.ntpSynchronized,
            source: null,
        };
    }

    return {
        status: input.ntpSynchronized === false ? "fail" : "warn",
        detail: `${ntpText}; could not sample external UTC, Reality budget ${budgetText}`,
        hint: CLOCK_HINT,
        skewMs: null,
        maxTimeDifferenceMs: budget,
        ntpSynchronized: input.ntpSynchronized,
        source: null,
    };
}

async function readNtpSynchronized(): Promise<boolean | null> {
    const show = await capture($`timedatectl show -p NTPSynchronized --value`);
    const v = show.stdout.trim().toLowerCase();
    if (show.ok && (v === "yes" || v === "true")) return true;
    if (show.ok && (v === "no" || v === "false")) return false;

    const timedate = await capture($`timedatectl`);
    if (!timedate.ok) return null;
    if (/System clock synchronized:\s+yes/i.test(timedate.stdout)) return true;
    if (/System clock synchronized:\s+no/i.test(timedate.stdout)) return false;
    return null;
}

async function readRealityMaxTimeDifferenceMs(): Promise<number> {
    const r = await capture($`docker compose exec -T panel cat /data/config/singbox.json`);
    if (!r.ok || !r.stdout.trim()) return DEFAULT_MAX_TIME_DIFFERENCE_MS;
    const raw = findRealityMaxTimeDifference(r.stdout);
    return parseDurationMs(raw) ?? DEFAULT_MAX_TIME_DIFFERENCE_MS;
}

async function sampleExternalUtc(): Promise<{ source: string; skewMs: number } | null> {
    const sources = [
        ["cloudflare", "https://www.cloudflare.com/"],
        ["google", "https://www.google.com/generate_204"],
        ["microsoft", "https://www.microsoft.com/"],
    ] as const;

    for (const [name, url] of sources) {
        const start = Date.now();
        const r = await capture($`curl -sSI --max-time 5 ${url}`);
        const end = Date.now();
        if (!r.stdout.trim()) continue;
        const remoteMs = parseHttpDateHeader(r.stdout);
        if (remoteMs === null) continue;
        const localMidpointMs = start + (end - start) / 2;
        return { source: name, skewMs: localMidpointMs - remoteMs };
    }

    return null;
}

export async function probeRealityClock(): Promise<RealityClockReport> {
    const [ntpSynchronized, maxTimeDifferenceMs, utcSample] = await Promise.all([
        readNtpSynchronized(),
        readRealityMaxTimeDifferenceMs(),
        sampleExternalUtc(),
    ]);

    return classifyRealityClock({
        skewMs: utcSample?.skewMs ?? null,
        source: utcSample?.source ?? null,
        maxTimeDifferenceMs,
        ntpSynchronized,
    });
}
