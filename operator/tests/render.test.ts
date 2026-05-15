// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/render.test.ts — argv parser for the `render` subcommand.

import { test, expect } from "bun:test";
import { parseArgs } from "../src/tasks/render";

test("parseArgs accepts each valid target", () => {
    const targets = ["caddyfile", "haproxy", "singbox"] as const;
    for (const t of targets) {
        const r = parseArgs(["bun", "operator", "render", t]);
        expect(typeof r).toBe("object");
        if (typeof r !== "object") return;
        expect(r.target).toBe(t);
        expect(r.passthrough).toEqual([]);
    }
});

test("parseArgs preserves passthrough args", () => {
    const r = parseArgs(["bun", "operator", "render", "singbox", "--if-changed"]);
    expect(typeof r).toBe("object");
    if (typeof r !== "object") return;
    expect(r.target).toBe("singbox");
    expect(r.passthrough).toEqual(["--if-changed"]);
});

test("parseArgs filters operator-global flags from passthrough", () => {
    const r = parseArgs(["bun", "operator", "render", "haproxy", "--json", "--no-bridge"]);
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

test("parseArgs errors when render verb missing from argv", () => {
    const r = parseArgs(["bun", "operator", "doctor"]);
    expect(typeof r).toBe("string");
    expect(r as string).toContain("command missing");
});
