// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/render.test.ts — argv parser for the `render` subcommand.
//
// v0.2.0+ only `caddyfile` is a live target; `haproxy` and `singbox`
// produce a friendly "retired in v0.2.0" hint so an operator running
// pre-v0.2.0 muscle memory or scrollback gets a useful message.

import { test, expect } from "bun:test";
import { parseArgs } from "../src/tasks/render";

test("parseArgs accepts caddyfile (the only live target in v0.2.0+)", () => {
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

test("parseArgs filters operator-global flags from passthrough", () => {
    const r = parseArgs(["bun", "operator", "render", "caddyfile", "--json", "--no-bridge"]);
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
    expect(r as string).toContain("retired in v0.2.0");
    expect(r as string).toContain("Use: render caddyfile");
});

test("parseArgs friendly-rejects retired v0.1.x targets (singbox)", () => {
    const r = parseArgs(["bun", "operator", "render", "singbox"]);
    expect(typeof r).toBe("string");
    expect(r as string).toContain("retired in v0.2.0");
});

test("parseArgs errors when render verb missing from argv", () => {
    const r = parseArgs(["bun", "operator", "doctor"]);
    expect(typeof r).toBe("string");
    expect(r as string).toContain("command missing");
});
