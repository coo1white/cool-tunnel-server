// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/bridge.test.ts — incident-bridge formatter + redaction.

import { test, expect } from "bun:test";
import { redact, redactContext, formatBridge } from "../src/diag/bridge";
import type { IncidentContext } from "../src/diag/types";

function makeCtx(overrides: Partial<IncidentContext> = {}): IncidentContext {
    const base: IncidentContext = {
        schema_version: 1,
        operator_version: "test",
        task: "doctor",
        exit_code: 1,
        ts: "2026-05-15T00:00:00Z",
        host: { kernel: "Linux 6.0", uptime_seconds: 1234 },
        ballast: {
            name: "ballast",
            ok: true,
            duration_ms: 10,
            data: {
                overall_ok: false,
                checks: [
                    { slug: "redis-ping", title: "Redis reachable", status: "fail", detail: "no PONG" },
                ],
            },
        },
        journal: { name: "journal", ok: true, duration_ms: 5, data: {} },
        metrics: {
            name: "sysmetrics", ok: true, duration_ms: 5,
            data: {
                cpu: { load_1m: 0, load_5m: 0, load_15m: 0, cores: 4 },
                memory: { total_kb: 0, available_kb: 0, used_pct: 0 },
                disk: [],
            },
        },
        proctree: { name: "proctree", ok: true, duration_ms: 5, data: { lines: [] } },
    };
    return { ...base, ...overrides };
}

test("redact masks IPv4 addresses", () => {
    expect(redact("connect to 192.168.1.42:80 failed")).toBe("connect to [ip]:80 failed");
});

test("redact masks bearer tokens", () => {
    const s = "Authorization: Bearer abcdefghij1234567890XYZ";
    expect(redact(s)).toContain("Bearer [redacted]");
});

test("redact masks key=value secrets", () => {
    expect(redact("password=hunter2")).toContain("password=[redacted]");
    expect(redact('TOKEN="abc123def"')).toContain("TOKEN=[redacted]");
});

test("redact masks standalone JWT-shaped strings", () => {
    // When the JWT appears free-standing (not as `key=<jwt>`), the JWT
    // pattern emits [jwt]. In key=value position the generic rule wins
    // and emits [redacted] — also safe, just a different marker.
    const jwt = "eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redact(`free-form ${jwt} in body`)).toContain("[jwt]");
});

test("redactContext walks journal lines", () => {
    const ctx = makeCtx({
        journal: {
            name: "journal", ok: true, duration_ms: 5,
            data: {
                panel: { unit: "panel (journalctl)", lines: ["connecting to 10.0.0.1"], truncated: false },
            },
        },
    });
    const out = redactContext(ctx);
    expect(out.journal.data["panel"]?.lines[0]).toContain("[ip]");
});

test("formatBridge produces JSON inside a fenced ctx block with the schema version", () => {
    const out = formatBridge(makeCtx());
    expect(out).toContain("<ctx schema=1>");
    expect(out).toContain("</ctx>");
    expect(out).toContain('"task": "doctor"');
    expect(out).toContain('"exit_code": 1');
});
