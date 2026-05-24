// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/recover.test.ts

import { expect, test } from "bun:test";
import { parseRecoverArgs, recoveryAdvice, summarizeRenderNames } from "../src/tasks/recover";

test("parseRecoverArgs defaults to diagnose", () => {
    expect(parseRecoverArgs(["bun", "operator", "recover"])).toEqual({ mode: "diagnose" });
    expect(parseRecoverArgs(["bun", "operator", "recover", "diagnose"])).toEqual({ mode: "diagnose" });
});

test("parseRecoverArgs accepts stale singbox repair aliases", () => {
    expect(parseRecoverArgs(["bun", "operator", "recover", "fix-stale-singbox"])).toEqual({
        mode: "fix-stale-singbox",
    });
    expect(parseRecoverArgs(["bun", "operator", "recover", "--fix-stale-singbox"])).toEqual({
        mode: "fix-stale-singbox",
    });
});

test("parseRecoverArgs rejects unknown modes", () => {
    const parsed = parseRecoverArgs(["bun", "operator", "recover", "wat"]);
    expect(typeof parsed).toBe("string");
    expect(parsed as string).toContain("unknown mode");
});

test("summarizeRenderNames keeps short lists readable", () => {
    expect(summarizeRenderNames("test1\n")).toBe("test1");
    expect(summarizeRenderNames("")).toBe("none");
});

test("summarizeRenderNames truncates long lists", () => {
    expect(summarizeRenderNames("a\nb\nc\nd\ne\nf\ng\nh\n")).toBe("a, b, c, d, e, f ... (+2 more)");
});

test("recoveryAdvice points zero-db nonzero-rendered case at stale repair", () => {
    expect(recoveryAdvice({
        dbVlessCount: 0,
        renderedUserCount: 1,
        renderedNames: "test1\n",
        credentialLockOk: false,
    })).toContain("ct recover fix-stale-singbox");
});

test("recoveryAdvice exits cleanly when credential-lock is ok", () => {
    expect(recoveryAdvice({
        dbVlessCount: 1,
        renderedUserCount: 1,
        renderedNames: "test1\n",
        credentialLockOk: true,
    })).toContain("./ct update");
});

test("recoveryAdvice points config validation failures at REALITY env", () => {
    expect(recoveryAdvice({
        dbVlessCount: null,
        renderedUserCount: null,
        renderedNames: "",
        credentialLockOk: false,
        renderOutput: "REALITY_PRIVATE_KEY must be a 43-character base64url X25519 key",
        env: {},
    })).toContain("REALITY_* values");
});

test("recover task sanitizes command output before printing diagnostics", async () => {
    const body = await Bun.file("./src/tasks/recover.ts").text();

    expect(body).toContain("redactSensitive");
    expect(body).toContain("redactSensitive(r.stdout)");
    expect(body).toContain("redactSensitive(r.stderr)");
    expect(body).toContain("redactSensitive(line)");
});
