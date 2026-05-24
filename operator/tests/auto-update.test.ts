// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/auto-update.test.ts — argv parser for the
// `auto-update` subcommand.

import { test, expect } from "bun:test";
import { ctUpdateFailureHint, gitPullFailureHint, parseAutoUpdateArgs } from "../auto-update";

test("parseAutoUpdateArgs: defaults to interactive + non-dry", () => {
    const r = parseAutoUpdateArgs(["bun", "operator", "auto-update"]);
    expect(typeof r).toBe("object");
    if (typeof r !== "object") return;
    expect(r.quiet).toBe(false);
    expect(r.dryRun).toBe(false);
});

test("parseAutoUpdateArgs: --quiet enables quiet mode", () => {
    const r = parseAutoUpdateArgs(["bun", "operator", "auto-update", "--quiet"]);
    if (typeof r !== "object") throw new Error("expected object");
    expect(r.quiet).toBe(true);
    expect(r.dryRun).toBe(false);
});

test("parseAutoUpdateArgs: short form -q + -n combine", () => {
    const r = parseAutoUpdateArgs(["bun", "operator", "auto-update", "-q", "-n"]);
    if (typeof r !== "object") throw new Error("expected object");
    expect(r.quiet).toBe(true);
    expect(r.dryRun).toBe(true);
});

test("parseAutoUpdateArgs: ignores operator-global --json", () => {
    const r = parseAutoUpdateArgs([
        "bun",
        "operator",
        "auto-update",
        "--json",
        "--dry-run",
    ]);
    if (typeof r !== "object") throw new Error("expected object");
    expect(r.dryRun).toBe(true);
});

test("parseAutoUpdateArgs: rejects unknown flags", () => {
    const r = parseAutoUpdateArgs(["bun", "operator", "auto-update", "--bogus"]);
    expect(typeof r).toBe("string");
    expect(r as string).toContain("unknown flag");
});

test("gitPullFailureHint: local changes get an actionable status hint", () => {
    const lines = gitPullFailureHint("error: Your local changes to the following files would be overwritten by merge:\n\t.env");
    expect(lines.join("\n")).toContain("checkout has local changes");
    expect(lines.join("\n")).toContain("git status --short");
    expect(lines.join("\n")).toContain("ct update");
});

test("gitPullFailureHint: network failures point at GitHub reachability", () => {
    const lines = gitPullFailureHint("fatal: unable to access 'https://github.com/coo1white/cool-tunnel-server.git/': Could not resolve host: github.com");
    expect(lines.join("\n")).toContain("GitHub was not reachable");
    expect(lines.join("\n")).toContain("curl -I https://github.com");
    expect(lines.join("\n")).toContain("ct auto-update --dry-run");
});

test("ctUpdateFailureHint: malformed APP_KEY names the env file and recovery command", () => {
    const lines = ctUpdateFailureHint(1, "Unsupported cipher or incorrect key length. Supported ciphers are: aes-128-cbc");
    expect(lines.join("\n")).toContain("APP_KEY is malformed");
    expect(lines.join("\n")).toContain("/opt/cool-tunnel-server/.env");
    expect(lines.join("\n")).toContain("ct recover diagnose");
});

test("ctUpdateFailureHint: decrypt failures point at previous keys or Reality reset", () => {
    const lines = ctUpdateFailureHint(1, "sing-box render failed: Could not decrypt the data.");
    expect(lines.join("\n")).toContain("cannot be decrypted");
    expect(lines.join("\n")).toContain("APP_PREVIOUS_KEYS");
    expect(lines.join("\n")).toContain("ct recover reset-reality");
});

test("ctUpdateFailureHint: generic failures still suggest recover diagnose", () => {
    const lines = ctUpdateFailureHint(2, "", "");
    expect(lines.join("\n")).toContain("partial state");
    expect(lines.join("\n")).toContain("ct update exited 2");
    expect(lines.join("\n")).toContain("ct recover diagnose");
});

test("ctUpdateFailureHint: detail line is redacted before cron logging", () => {
    const lines = ctUpdateFailureHint(
        1,
        "APP_KEY=base64:abcdefghijklmnop1234567890ABCDEFGHIJKLMNOP== https://panel.example.com/api/v1/subscription/abcDEF_123-xyz",
    );
    const joined = lines.join("\n");

    expect(joined).toContain("APP_KEY=<redacted>");
    expect(joined).toContain("/api/v1/subscription/<redacted>");
    expect(joined).not.toContain("abcDEF_123-xyz");
});
