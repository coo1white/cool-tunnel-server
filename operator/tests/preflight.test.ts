// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/preflight.test.ts — pure logic in
// operator/src/util/preflight.ts.

import { expect, test } from "bun:test";
import {
  checkNetwork,
  classifyDiskSpace,
  classifyIpv4OnlyPreflight,
  classifyStackUp,
  dockerDaemonIsIpv4Only,
  kbToGb,
  mergeDockerDaemonIpv4Only,
  parseDfAvailableKb,
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
  // The parser joins the data rows so the Available column still lines up
  // even when the long device name wraps onto its own line.
  expect(parseDfAvailableKb(out)).toBe(35000000);
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

// ---------- classifyDiskSpace ----------

test("classifyDiskSpace accepts repo + docker headroom at the thresholds", () => {
  const r = classifyDiskSpace(
    { repoGb: 2, dockerGb: 4, dockerRoot: "/var/lib/docker" },
    { minRepoGb: 2, minDockerGb: 4 },
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.summary).toContain("repo: 2G, docker: 4G");
});

test("classifyDiskSpace reports repo pressure after auto-clean already ran", () => {
  const r = classifyDiskSpace(
    { repoGb: 1, dockerGb: 8, dockerRoot: "/var/lib/docker" },
    { minRepoGb: 2, minDockerGb: 4 },
  );
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.failure.summary).toContain("low disk under repo path");
    expect(r.failure.diag).toContain("auto-clean step already attempted");
    expect(r.failure.diag).toContain("never touches Docker volumes");
  }
});

test("classifyDiskSpace reports docker root pressure with the detected root path", () => {
  const r = classifyDiskSpace(
    { repoGb: 10, dockerGb: 3, dockerRoot: "/srv/docker" },
    { minRepoGb: 2, minDockerGb: 4 },
  );
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.failure.summary).toContain("/srv/docker");
    expect(r.failure.diag).toContain("/srv/docker/overlay2");
    expect(r.failure.diag).not.toContain("docker volume rm");
  }
});

// ---------- classifyStackUp ----------

test("classifyStackUp: all required services running → ok", () => {
  const r = classifyStackUp(
    ["admin-api", "admin-web", "caddy"],
    new Set(["admin-api", "admin-web", "caddy", "singbox", "docker-proxy", "redis"]),
  );
  expect(r.ok).toBe(true);
  expect(r.missing).toEqual([]);
  expect(r.runningCount).toBe(3);
  expect(r.summary).toContain("stack is up");
});

test("classifyStackUp: some required missing → ok=true (partial) with summary", () => {
  const r = classifyStackUp(["admin-api", "admin-web", "caddy"], new Set(["admin-api"]));
  expect(r.ok).toBe(true); // partial-up doesn't refuse to proceed
  expect(r.missing).toEqual(["admin-web", "caddy"]);
  expect(r.runningCount).toBe(1);
  expect(r.summary).toContain("partially up");
});

test("classifyStackUp: ALL required missing → ok=false with install.sh hint", () => {
  const r = classifyStackUp(["admin-api", "admin-web", "caddy"], new Set());
  expect(r.ok).toBe(false);
  expect(r.missing).toEqual(["admin-api", "admin-web", "caddy"]);
  expect(r.runningCount).toBe(0);
  expect(r.failure).toBeDefined();
  expect(r.failure!.diag).toContain("install.sh");
});

test("classifyStackUp: ALL required missing but other services running → still ok=false", () => {
  // The bash original uses `--services` so the running set is
  // already filtered to compose services; if none of OUR required
  // services overlap, we treat it as entirely down even if other
  // services are running.
  const r = classifyStackUp(["admin-api"], new Set(["singbox", "caddy"]));
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
    ["github.com", "release-assets.githubusercontent.com"],
    async (h) => h !== "github.com",
  );
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.failure.summary).toContain("github.com");
    expect(r.failure.summary).not.toContain("release-assets.githubusercontent.com");
    expect(r.failure.diag).toContain("HTTPS_PROXY");
    expect(r.failure.diag).toContain("./scripts/fetch_image_bundle.sh");
  }
});

test("checkNetwork: every probe fails → both hosts listed", async () => {
  const r = await checkNetwork(["a", "b"], async () => false);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.failure.summary).toContain("a b");
  }
});

// ---------- classifyIpv4OnlyPreflight ----------

test("classifyIpv4OnlyPreflight: CT_SKIP_IPV6_AUTO_DISABLE=1 → skipped", () => {
  const r = classifyIpv4OnlyPreflight({
    skipEnv: true,
    sysctlPresent: false,
    hasGlobalRoute: false,
    canDetect: true,
    fixResult: null,
  });
  expect(r.action).toBe("skipped");
  expect(r.detail).toContain("CT_SKIP_IPV6_AUTO_DISABLE");
});

test("classifyIpv4OnlyPreflight: no `curl` binary and no fix → warn", () => {
  const r = classifyIpv4OnlyPreflight({
    skipEnv: false,
    sysctlPresent: false,
    hasGlobalRoute: false,
    canDetect: false,
    fixResult: null,
  });
  expect(r.action).toBe("warn");
  expect(r.detail).toContain("curl");
});

test("classifyIpv4OnlyPreflight: existing sysctl + Docker override → ok", () => {
  const r = classifyIpv4OnlyPreflight({
    skipEnv: false,
    sysctlPresent: true,
    hasGlobalRoute: false,
    canDetect: true,
    dockerDaemonIpv4Only: true,
    fixResult: { ok: true, detail: "IPv4-only already enforced" },
  });
  expect(r.action).toBe("ok");
});

test("classifyIpv4OnlyPreflight: sysctl exists but docker daemon still needs IPv4-only fix", () => {
  const r = classifyIpv4OnlyPreflight({
    skipEnv: false,
    sysctlPresent: true,
    hasGlobalRoute: false,
    canDetect: true,
    dockerDaemonIpv4Only: false,
    fixResult: { ok: true, detail: "wrote Docker daemon config" },
  });
  expect(r.action).toBe("fixed");
  expect(r.detail).toContain("Docker daemon");
});

test("classifyIpv4OnlyPreflight: static rust unreachable over IPv4 reports network issue after enforcement", () => {
  const r = classifyIpv4OnlyPreflight({
    skipEnv: false,
    sysctlPresent: false,
    hasGlobalRoute: false,
    canDetect: true,
    rustStaticIpv4Ok: false,
    fixResult: { ok: true, detail: "enforced" },
  });
  expect(r.action).toBe("warn");
  expect(r.detail).toContain("static.rust-lang.org");
});

test("classifyIpv4OnlyPreflight: working global route still enforces IPv4-only", () => {
  const r = classifyIpv4OnlyPreflight({
    skipEnv: false,
    sysctlPresent: false,
    hasGlobalRoute: true,
    canDetect: true,
    fixResult: { ok: true, detail: "enforced" },
  });
  expect(r.action).toBe("fixed");
  expect(r.detail).toContain("IPv4-only");
});

test("classifyIpv4OnlyPreflight: IPv4-only enforcement success → fixed", () => {
  const r = classifyIpv4OnlyPreflight({
    skipEnv: false,
    sysctlPresent: false,
    hasGlobalRoute: false,
    canDetect: true,
    fixResult: { ok: true },
  });
  expect(r.action).toBe("fixed");
  expect(r.detail).toContain("IPv4");
});

test("classifyIpv4OnlyPreflight: IPv4-only enforcement failure → warn with recovery hint", () => {
  const r = classifyIpv4OnlyPreflight({
    skipEnv: false,
    sysctlPresent: false,
    hasGlobalRoute: false,
    canDetect: true,
    fixResult: { ok: false, detail: "permission denied on sysctl.d" },
  });
  expect(r.action).toBe("warn");
  expect(r.detail).toContain("./ct update");
});

// ---------- Docker daemon IPv4-only merge ----------

test("mergeDockerDaemonIpv4Only creates a minimal config when daemon.json is missing", () => {
  const r = mergeDockerDaemonIpv4Only(null);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(JSON.parse(r.text)).toEqual({
      ipv6: false,
      dns: ["1.1.1.1", "8.8.8.8"],
    });
    expect(r.changed).toBe(true);
  }
});

test("mergeDockerDaemonIpv4Only preserves existing Docker daemon keys", () => {
  const r = mergeDockerDaemonIpv4Only('{"log-driver":"json-file","dns":["9.9.9.9"],"ipv6":true}');
  expect(r.ok).toBe(true);
  if (r.ok) {
    const parsed = JSON.parse(r.text);
    expect(parsed["log-driver"]).toBe("json-file");
    expect(parsed.dns).toEqual(["9.9.9.9"]);
    expect(parsed.ipv6).toBe(false);
  }
});

test("dockerDaemonIsIpv4Only only accepts exact Docker IPv4-only config", () => {
  expect(dockerDaemonIsIpv4Only('{"ipv6":false,"dns":["1.1.1.1"]}\n')).toBe(true);
  expect(dockerDaemonIsIpv4Only('{"ipv6":true}')).toBe(false);
  expect(dockerDaemonIsIpv4Only("{nope")).toBe(false);
});
