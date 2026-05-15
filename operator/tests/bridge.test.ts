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
        compose: { name: "compose", ok: true, duration_ms: 5, data: { services: [] } },
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
    const jwt = "eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"; // gitleaks:allow
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

// Dogfood — reconstructs the diagnostic shape for the v0.1.3 haproxy
// SIGHUP incident (CHANGELOG.md::[0.1.3]). haproxy exited; ballast
// haproxy-stats fails; compose state shows haproxy with state "exited"
// and a non-zero exit code; everything else still up.
test("haproxy-exited incident fixture exposes the deciding evidence", () => {
    const ctx = makeCtx({
        task: "readiness",
        ballast: {
            name: "ballast", ok: true, duration_ms: 12,
            data: {
                overall_ok: false,
                checks: [
                    { slug: "panel-octane-up",  title: "Panel Octane responds on /up", status: "pass" },
                    { slug: "haproxy-stats",    title: "HAProxy stats socket",         status: "fail", detail: "stats socket unreachable" },
                    { slug: "redis-ping",       title: "Redis reachable",              status: "pass" },
                ],
            },
        },
        compose: {
            name: "compose", ok: true, duration_ms: 8,
            data: {
                services: [
                    { service: "panel",    name: "ct-panel",    state: "running", status: "Up 2 hours (healthy)" },
                    { service: "haproxy",  name: "ct-haproxy",  state: "exited",  status: "Exited (137) 30 seconds ago", exit_code: 137 },
                    { service: "caddy",    name: "ct-caddy",    state: "running", status: "Up 2 hours" },
                    { service: "sing-box", name: "ct-sing-box", state: "running", status: "Up 2 hours (healthy)" },
                    { service: "redis",    name: "ct-redis",    state: "running", status: "Up 2 hours" },
                ],
            },
        },
    });
    const out = formatBridge(ctx);
    // The reader should see the failing ballast check.
    expect(out).toContain('"slug": "haproxy-stats"');
    expect(out).toContain('"status": "fail"');
    // The reader should see the compose state showing haproxy exited.
    expect(out).toContain('"service": "haproxy"');
    expect(out).toContain('"state": "exited"');
    expect(out).toContain('"exit_code": 137');
    // The new prompt header should be intact.
    expect(out).toContain("diagnosis grounded in specific evidence");
    expect(out).toContain("ballast check slug");
});
