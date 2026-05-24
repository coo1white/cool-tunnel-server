// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/render.test.ts — argv parser for the `render` subcommand.
//
// v0.4.0+ supports both `caddyfile` and `singbox`; `haproxy` remains
// retired and produces a friendly hint for old runbooks.

import { test, expect } from "bun:test";
import { parseArgs, renderFailureSummary } from "../src/tasks/render";

test("parseArgs accepts caddyfile", () => {
    const r = parseArgs(["bun", "operator", "render", "caddyfile"]);
    expect(typeof r).toBe("object");
    if (typeof r !== "object") return;
    expect(r.target).toBe("caddyfile");
    expect(r.passthrough).toEqual([]);
});

test("parseArgs preserves passthrough args after caddyfile", () => {
    const r = parseArgs(["bun", "operator", "render", "caddyfile", "--if-changed"]);
    expect(typeof r).toBe("object");
    if (typeof r !== "object") return;
    expect(r.target).toBe("caddyfile");
    expect(r.passthrough).toEqual(["--if-changed"]);
});

test("parseArgs accepts singbox", () => {
    const r = parseArgs(["bun", "operator", "render", "singbox"]);
    expect(typeof r).toBe("object");
    if (typeof r !== "object") return;
    expect(r.target).toBe("singbox");
    expect(r.passthrough).toEqual([]);
});

test("parseArgs preserves passthrough args after singbox", () => {
    const r = parseArgs(["bun", "operator", "render", "singbox", "--if-changed"]);
    expect(typeof r).toBe("object");
    if (typeof r !== "object") return;
    expect(r.target).toBe("singbox");
    expect(r.passthrough).toEqual(["--if-changed"]);
});

test("parseArgs filters operator-global flags from passthrough", () => {
    const r = parseArgs(["bun", "operator", "render", "caddyfile", "--json"]);
    expect(typeof r).toBe("object");
    if (typeof r !== "object") return;
    expect(r.passthrough).toEqual([]);
});

test("parseArgs rejects missing target", () => {
    const r = parseArgs(["bun", "operator", "render"]);
    expect(typeof r).toBe("string");
    expect(r as string).toContain("target required");
});

test("parseArgs rejects unknown target", () => {
    const r = parseArgs(["bun", "operator", "render", "bogus"]);
    expect(typeof r).toBe("string");
    expect(r as string).toContain("unknown target");
});

test("parseArgs friendly-rejects retired v0.1.x targets (haproxy)", () => {
    const r = parseArgs(["bun", "operator", "render", "haproxy"]);
    expect(typeof r).toBe("string");
    expect(r as string).toContain("retired");
    expect(r as string).toContain("caddyfile");
    expect(r as string).toContain("singbox");
});

test("parseArgs errors when render verb missing from argv", () => {
    const r = parseArgs(["bun", "operator", "doctor"]);
    expect(typeof r).toBe("string");
    expect(r as string).toContain("command missing");
});

test("renderFailureSummary explains malformed APP_KEY", () => {
    const summary = renderFailureSummary(
        "singbox",
        1,
        "sing-box render failed: Unsupported cipher or incorrect key length.",
        "",
    );

    expect(summary).toContain("APP_KEY is malformed");
    expect(summary).toContain("docker compose restart panel");
});

test("renderFailureSummary explains Reality decrypt drift", () => {
    const summary = renderFailureSummary(
        "singbox",
        1,
        "sing-box render failed: Could not decrypt the data.",
        "",
    );

    expect(summary).toContain("APP_KEY cannot decrypt");
    expect(summary).toContain("ct recover reset-reality");
});

test("renderFailureSummary gives a recovery command for unknown render failures", () => {
    const summary = renderFailureSummary("caddyfile", 1, "", "ct-server-core exited 1");

    expect(summary).toContain("caddyfile render failed");
    expect(summary).toContain("ct recover diagnose");
});

test("render task redacts command output before printing", async () => {
    const body = await Bun.file("./src/tasks/render.ts").text();

    expect(body).toContain("redactSensitive(r.stdout)");
    expect(body).toContain("redactSensitive(r.stderr)");
});
