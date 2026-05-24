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

test("parseRecoverArgs accepts Reality reset aliases", () => {
    expect(parseRecoverArgs(["bun", "operator", "recover", "reset-reality"])).toEqual({
        mode: "reset-reality",
    });
    expect(parseRecoverArgs(["bun", "operator", "recover", "--reset-reality"])).toEqual({
        mode: "reset-reality",
    });
    expect(parseRecoverArgs(["bun", "operator", "recover", "fix-app-key-drift"])).toEqual({
        mode: "reset-reality",
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

test("recoveryAdvice identifies malformed APP_KEY", () => {
    expect(recoveryAdvice({
        dbVlessCount: null,
        renderedUserCount: null,
        renderedNames: "",
        credentialLockOk: false,
        renderOutput: "Unsupported cipher or incorrect key length.",
        env: { APP_KEY: "base64:Zm9v" },
    })).toContain("APP_KEY is missing or malformed");
});

test("recoveryAdvice identifies malformed APP_PREVIOUS_KEYS separately", () => {
    const advice = recoveryAdvice({
        dbVlessCount: null,
        renderedUserCount: null,
        renderedNames: "",
        credentialLockOk: false,
        renderOutput: "Unsupported cipher or incorrect key length.",
        env: {
            APP_KEY: "base64:JCsdgKuqbLm9GnIQ6L+8MKf1gfgPYxKCWgVJB8x3qvE=",
            APP_PREVIOUS_KEYS: "base64:Zm9v",
        },
    });

    expect(advice).toContain("APP_PREVIOUS_KEYS contains malformed fallback keys");
    expect(advice).not.toContain("reset-reality");
});

test("recoveryAdvice identifies unrecoverable Reality decrypt drift", () => {
    expect(recoveryAdvice({
        dbVlessCount: null,
        renderedUserCount: null,
        renderedNames: "",
        credentialLockOk: false,
        renderOutput: "sing-box render failed: Could not decrypt the data.",
        env: { APP_KEY: "base64:JCsdgKuqbLm9GnIQ6L+8MKf1gfgPYxKCWgVJB8x3qvE=" },
    })).toContain("ct recover reset-reality");
});

test("recover task sanitizes command output before printing diagnostics", async () => {
    const body = await Bun.file("./src/tasks/recover.ts").text();

    expect(body).toContain("redactSensitive");
    expect(body).toContain("redactSensitive(r.stdout)");
    expect(body).toContain("redactSensitive(r.stderr)");
    expect(body).toContain("redactSensitive(line)");
});
