// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/reality-clock.test.ts — Reality clock-budget helpers.

import { expect, test } from "bun:test";
import {
    classifyRealityClock,
    findRealityMaxTimeDifference,
    parseDurationMs,
    parseHttpDateHeader,
} from "../src/util/reality-clock";

test("parseDurationMs accepts sing-box style duration strings", () => {
    expect(parseDurationMs("1m")).toBe(60_000);
    expect(parseDurationMs("90s")).toBe(90_000);
    expect(parseDurationMs("1m30s")).toBe(90_000);
    expect(parseDurationMs("500ms")).toBe(500);
});

test("parseDurationMs rejects malformed duration strings", () => {
    expect(parseDurationMs("")).toBeNull();
    expect(parseDurationMs("1 minute")).toBeNull();
    expect(parseDurationMs("m1")).toBeNull();
});

test("findRealityMaxTimeDifference reads the inbound Reality budget", () => {
    const cfg = JSON.stringify({
        inbounds: [
            {
                tls: {
                    reality: {
                        enabled: true,
                        max_time_difference: "1m",
                    },
                },
            },
        ],
    });
    expect(findRealityMaxTimeDifference(cfg)).toBe("1m");
});

test("parseHttpDateHeader extracts Date header epoch", () => {
    const ms = parseHttpDateHeader("HTTP/2 200\r\ndate: Mon, 18 May 2026 18:43:43 GMT\r\n\r\n");
    expect(ms).toBe(Date.parse("Mon, 18 May 2026 18:43:43 GMT"));
});

test("classifyRealityClock fails when skew exceeds Reality budget", () => {
    const r = classifyRealityClock({
        skewMs: 94_000,
        maxTimeDifferenceMs: 60_000,
        ntpSynchronized: true,
        source: "cloudflare",
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("exceeds Reality budget 1m");
});

test("classifyRealityClock passes when skew is tiny and NTP is synced", () => {
    const r = classifyRealityClock({
        skewMs: 3_000,
        maxTimeDifferenceMs: 60_000,
        ntpSynchronized: true,
        source: "cloudflare",
    });
    expect(r.status).toBe("pass");
});
