// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/preflight.test.ts — pure logic in
// operator/src/util/preflight.ts.

import { test, expect } from "bun:test";
import {
    parseDfAvailableKb,
    kbToGb,
    classifyStackUp,
    checkNetwork,
    classifyIpv6Preflight,
} from "../src/util/preflight";

// ---------- parseDfAvailableKb ----------

test("parseDfAvailableKb reads col 4 from a standard `df -k` row", () => {
    const out = `Filesystem     1K-blocks    Used Available Use% Mounted on
/dev/sda1       50000000 10000000  35000000  23% /
`;
    expect(parseDfAvailableKb(out)).toBe(35000000);
});

test("parseDfAvailableKb tolerates a wrapped Filesystem name", () => {
    // Some hosts (long device names) wrap onto a second line; the
    // numeric trio then appears on its own row with 5 columns.
    const out = `Filesystem    1K-blocks    Used Available Use% Mounted on
/some/very/long/device-mapper/lv-name
              50000000 10000000  35000000  23% /
`;
    // Our parser reads row 2 — the wrap case the bash original
    // doesn't handle either. We accept that limitation as a known
    // edge case; just verify the standard path stays correct.
    // (Test purely documents current behaviour; if we ever upgrade
    // the parser to handle wraps, this assertion can flip.)
    expect(parseDfAvailableKb(out)).toBeNull();
});

test("parseDfAvailableKb returns null on a non-numeric Available column", () => {
    const out = `Filesystem     1K-blocks    Used Available Use% Mounted on
/dev/sda1       50000000 10000000  oops      23% /
`;
    expect(parseDfAvailableKb(out)).toBeNull();
});

test("parseDfAvailableKb returns null when there's no row 2", () => {
    expect(parseDfAvailableKb("Filesystem 1K-blocks Used Available Use% Mounted on")).toBeNull();
    expect(parseDfAvailableKb("")).toBeNull();
});

// ---------- kbToGb ----------

test("kbToGb floors to whole GB (1 GB = 1024 MB = 1024*1024 KB)", () => {
    expect(kbToGb(0)).toBe(0);
    expect(kbToGb(1024 * 1024)).toBe(1); // exactly 1 GB
    expect(kbToGb(2 * 1024 * 1024 - 1)).toBe(1); // just under 2 GB
    expect(kbToGb(2 * 1024 * 1024)).toBe(2);
    expect(kbToGb(50_000_000)).toBe(47); // 50e6 KB ≈ 47.68 GB → floor 47
});

// ---------- classifyStackUp ----------

test("classifyStackUp: all required services running → ok", () => {
    const r = classifyStackUp(
        ["panel", "caddy"],
        new Set(["panel", "caddy", "singbox", "redis", "db"]),
    );
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.runningCount).toBe(2);
    expect(r.summary).toContain("stack is up");
});

test("classifyStackUp: some required missing → ok=true (partial) with summary", () => {
    const r = classifyStackUp(
        ["panel", "caddy"],
        new Set(["panel"]),
    );
    expect(r.ok).toBe(true); // partial-up doesn't refuse to proceed
    expect(r.missing).toEqual(["caddy"]);
    expect(r.runningCount).toBe(1);
    expect(r.summary).toContain("partially up");
});

test("classifyStackUp: ALL required missing → ok=false with install.sh hint", () => {
    const r = classifyStackUp(
        ["panel", "caddy"],
        new Set(),
    );
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["panel", "caddy"]);
    expect(r.runningCount).toBe(0);
    expect(r.failure).toBeDefined();
    expect(r.failure!.diag).toContain("install.sh");
});

test("classifyStackUp: ALL required missing but other services running → still ok=false", () => {
    // The bash original uses `--services` so the running set is
    // already filtered to compose services; if none of OUR required
    // services overlap, we treat it as entirely down even if other
    // services are running.
    const r = classifyStackUp(
        ["panel"],
        new Set(["redis", "db"]),
    );
    expect(r.ok).toBe(false);
    expect(r.runningCount).toBe(0);
});

// ---------- checkNetwork ----------

test("checkNetwork: all probes ok → result ok with summary", async () => {
    const r = await checkNetwork(["a.example.com", "b.example.com"], async () => true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.summary).toContain("a.example.com b.example.com");
});

test("checkNetwork: one probe fails → result reports just that host", async () => {
    const r = await checkNetwork(
        ["github.com", "registry-1.docker.io"],
        async (h) => h !== "github.com",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
        expect(r.failure.summary).toContain("github.com");
        expect(r.failure.summary).not.toContain("registry-1.docker.io");
        expect(r.failure.diag).toContain("HTTPS_PROXY");
    }
});

test("checkNetwork: every probe fails → both hosts listed", async () => {
    const r = await checkNetwork(["a", "b"], async () => false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
        expect(r.failure.summary).toContain("a b");
    }
});

// ---------- classifyIpv6Preflight ----------

test("classifyIpv6Preflight: CT_SKIP_IPV6_AUTO_DISABLE=1 → skipped", () => {
    const r = classifyIpv6Preflight({
        skipEnv: true,
        sysctlPresent: false,
        hasGlobalIpv6: false,
        canDetect: true,
        fixResult: null,
    });
    expect(r.action).toBe("skipped");
    expect(r.detail).toContain("CT_SKIP_IPV6_AUTO_DISABLE");
});

test("classifyIpv6Preflight: no `ip` binary → skipped (non-Linux host)", () => {
    const r = classifyIpv6Preflight({
        skipEnv: false,
        sysctlPresent: false,
        hasGlobalIpv6: false,
        canDetect: false,
        fixResult: null,
    });
    expect(r.action).toBe("skipped");
    expect(r.detail).toContain("ip");
});

test("classifyIpv6Preflight: existing sysctl override → ok (no-op)", () => {
    const r = classifyIpv6Preflight({
        skipEnv: false,
        sysctlPresent: true,
        hasGlobalIpv6: false,
        canDetect: true,
        fixResult: null,
    });
    expect(r.action).toBe("ok");
});

test("classifyIpv6Preflight: working IPv6 globally → ok (no fix needed)", () => {
    const r = classifyIpv6Preflight({
        skipEnv: false,
        sysctlPresent: false,
        hasGlobalIpv6: true,
        canDetect: true,
        fixResult: null,
    });
    expect(r.action).toBe("ok");
});

test("classifyIpv6Preflight: broken IPv6 + successful auto-fix → fixed", () => {
    const r = classifyIpv6Preflight({
        skipEnv: false,
        sysctlPresent: false,
        hasGlobalIpv6: false,
        canDetect: true,
        fixResult: { ok: true },
    });
    expect(r.action).toBe("fixed");
    expect(r.detail).toContain("IPv4");
});

test("classifyIpv6Preflight: broken IPv6 + failed auto-fix → warn with recovery hint", () => {
    const r = classifyIpv6Preflight({
        skipEnv: false,
        sysctlPresent: false,
        hasGlobalIpv6: false,
        canDetect: true,
        fixResult: { ok: false, detail: "permission denied on sysctl.d" },
    });
    expect(r.action).toBe("warn");
    expect(r.detail).toContain("./ct update");
});
