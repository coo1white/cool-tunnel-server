// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/preflight.ts — pre-flight checks for the
// update / install / restore scripts.
//
// Mirrors scripts/lib.sh's preflight_* helpers. Each check returns
// a structured `PreflightResult` so callers can decide whether to
// die() or warn() or accumulate failures. Pure logic (free-space
// math, threshold compare) is split into named helpers so it can
// be unit-tested without spawning subprocesses.

import { mkdirSync } from "node:fs";
import { $, capture, which } from "./sh";
import type { DiagFailure } from "./diag";

export type PreflightResult =
    | { readonly ok: true; readonly summary?: string }
    | { readonly ok: false; readonly failure: DiagFailure };

// ---------- preflight_network ----------

const DEFAULT_NETWORK_HOSTS = ["github.com", "registry-1.docker.io"] as const;

// Pure: classify a list of probe results into reachable/unreachable.
// `probe` is the caller-supplied checker (defaults to a curl HEAD
// request), exported so tests can inject a deterministic mock.
//
// The bash original tolerates ANY HTTP response code (4xx counts
// as "reachable" — the round trip completed); a v0.0.97 fix
// dropped curl's -f for exactly that reason. We honour the same
// rule by treating any non-error subprocess exit as reachable.
export async function checkNetwork(
    hosts: readonly string[] = DEFAULT_NETWORK_HOSTS,
    probe?: (host: string) => Promise<boolean>,
): Promise<PreflightResult> {
    const checkHost = probe ?? defaultNetworkProbe;
    const unreachable: string[] = [];
    for (const h of hosts) {
        if (!(await checkHost(h))) unreachable.push(h);
    }
    if (unreachable.length === 0) {
        return { ok: true, summary: `network reachable (${hosts.join(" ")})` };
    }
    return {
        ok: false,
        failure: {
            summary: `network: cannot reach ${unreachable.join(" ")}`,
            diag: `Update needs to git pull (github.com) and pull image layers
(registry-1.docker.io). One or both is unreachable.

What to check (in priority order):
  ping -c 3 1.1.1.1                  # internet reachable at all?
  dig +short github.com              # DNS resolving?
  curl -v https://github.com/        # outbound 443 not blocked?
  printenv HTTPS_PROXY               # corporate proxy needed?
  docker info | grep -A3 Registry    # registry mirror configured?

When the network is back, re-run:
  ./ct update`,
        },
    };
}

async function defaultNetworkProbe(host: string): Promise<boolean> {
    const r = await capture(
        $`curl -sS --connect-timeout 5 --max-time 10 -o /dev/null https://${host}/`,
    );
    return r.ok;
}

// ---------- preflight_disk_space ----------

export interface DiskSpaceThresholds {
    readonly minRepoGb: number;
    readonly minDockerGb: number;
}

export interface DiskSpaceMeasurement {
    readonly repoGb: number;
    readonly dockerGb: number;
    readonly dockerRoot: string;
}

export const DEFAULT_DISK_THRESHOLDS: DiskSpaceThresholds = {
    minRepoGb: 2,
    minDockerGb: 4,
};

// Pure: parse `df -k <path>` output (the canonical Linux/POSIX
// form) and extract the available-KB count from row 2 col 4. The
// bash original does `awk 'NR==2 {print $4}'` against the same
// input.
export function parseDfAvailableKb(dfOutput: string): number | null {
    const lines = dfOutput.split("\n");
    if (lines.length < 2) return null;
    const row = lines[1]!.trim().split(/\s+/);
    // df -k columns: Filesystem | 1K-blocks | Used | Available | Use% | Mounted on
    // On some hosts the Filesystem name wraps to a second line — we
    // tolerate that by reading col 3 (Available) when the row has 5
    // tokens (no Filesystem name) and col 3 when the row has 6.
    // Either way it's column "Available" relative to a row with the
    // numeric trio.
    if (row.length >= 6) {
        const n = parseInt(row[3]!, 10);
        return Number.isFinite(n) ? n : null;
    }
    if (row.length === 5) {
        const n = parseInt(row[2]!, 10);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

export function kbToGb(kb: number): number {
    return Math.floor(kb / 1024 / 1024);
}

export function formatDiskSpaceSummary(m: DiskSpaceMeasurement): string {
    return `disk space OK (repo: ${m.repoGb}G, docker: ${m.dockerGb}G)`;
}

export async function measureDiskSpace(): Promise<DiskSpaceMeasurement> {
    const repoDf = await capture($`df -k .`);
    const repoKb = repoDf.ok ? parseDfAvailableKb(repoDf.stdout) ?? 0 : 0;
    const repoGb = kbToGb(repoKb);

    const dockerInfo = await capture($`docker info --format ${"{{.DockerRootDir}}"}`);
    const dockerRoot = dockerInfo.ok && dockerInfo.stdout.trim()
        ? dockerInfo.stdout.trim()
        : "/var/lib/docker";
    const dockerDf = await capture($`df -k ${dockerRoot}`);
    const dockerKb = dockerDf.ok ? parseDfAvailableKb(dockerDf.stdout) ?? 0 : 0;
    const dockerGb = kbToGb(dockerKb);

    return { repoGb, dockerGb, dockerRoot };
}

export function classifyDiskSpace(
    m: DiskSpaceMeasurement,
    thresholds: DiskSpaceThresholds = DEFAULT_DISK_THRESHOLDS,
): PreflightResult {
    if (m.repoGb < thresholds.minRepoGb) {
        return {
            ok: false,
            failure: {
                summary: `low disk under repo path: ${m.repoGb}G free, need >= ${thresholds.minRepoGb}G`,
                diag: `Compose build, git pull, and composer install all need scratch
space; running out mid-update corrupts the build cache.

The install/update auto-clean step already attempted safe temp/build
cache cleanup first and never touches Docker volumes, backups, .env,
or database data. This means the VPS is still too full for a reliable
deploy.

What to free (priority order, most-impact first):
  docker system prune -af        # unused images + containers
  docker builder prune -af       # all buildkit cache (1-3 GB typical)
  du -h --max-depth=1 / | sort -rh | head    # find the actual offender

Re-run ./ct install or ./ct update after freeing space.`,
            },
        };
    }

    if (m.dockerGb < thresholds.minDockerGb) {
        return {
            ok: false,
            failure: {
                summary: `low disk under docker root (${m.dockerRoot}): ${m.dockerGb}G free, need >= ${thresholds.minDockerGb}G`,
                diag: `Compose pull + build will store image layers under ${m.dockerRoot}.
Out-of-space mid-build typically surfaces as 'no space left on
device' partway through, leaving a half-built panel image and a
confused stack.

The install/update auto-clean step already attempted conservative
Docker cleanup first (no volumes, no backups). This means the VPS
still needs manual space recovery before a reliable deploy.

What to free (priority order):
  docker system prune -af
  docker builder prune -af
  du -sh ${m.dockerRoot}/* | sort -rh | head
  du -sh ${m.dockerRoot}/overlay2/*  | sort -rh | head`,
            },
        };
    }

    return { ok: true, summary: formatDiskSpaceSummary(m) };
}

export async function checkDiskSpace(
    thresholds: DiskSpaceThresholds = DEFAULT_DISK_THRESHOLDS,
): Promise<PreflightResult> {
    return classifyDiskSpace(await measureDiskSpace(), thresholds);
}

// ---------- preflight_stack_up ----------

export interface StackUpResult {
    readonly ok: boolean; // false only when ALL services are missing
    readonly summary: string;
    readonly missing: readonly string[];
    readonly runningCount: number;
    readonly failure?: DiagFailure;
}

// Pure: given the set of required services + the set of currently-
// running services, compute the missing list + summary. Exported
// for tests; the I/O wrapper below feeds it real docker output.
export function classifyStackUp(
    required: readonly string[],
    running: ReadonlySet<string>,
): StackUpResult {
    const missing = required.filter((s) => !running.has(s));
    const runningCount = required.length - missing.length;
    if (missing.length === 0) {
        return {
            ok: true,
            summary: `stack is up (${runningCount}/${required.length} services running)`,
            missing: [],
            runningCount,
        };
    }
    if (runningCount === 0) {
        return {
            ok: false,
            summary: "stack is entirely down",
            missing,
            runningCount: 0,
            failure: {
                summary: "stack is entirely down",
                diag: `None of the expected services are running:
  ${required.join(" ")}

You probably want install.sh, not update.sh. update.sh assumes a
live stack and reuses its volumes + cache.

What to do:
  First-time setup on a fresh box:
    ./scripts/install.sh

  Stack was running and crashed:
    docker compose ps                # what is the state?
    docker compose logs --tail=80    # what blew up?
    docker compose up -d             # bring it back up
    ./ct update              # then update`,
            },
        };
    }
    return {
        ok: true,
        summary: `stack is partially up — these services are NOT running: ${missing.join(" ")}`,
        missing,
        runningCount,
    };
}

export async function checkStackUp(services: readonly string[]): Promise<StackUpResult> {
    if (services.length === 0) {
        return { ok: true, summary: "preflight_stack_up: no services specified, skipping", missing: [], runningCount: 0 };
    }
    // Bash version uses `--status running --status restarting` so we
    // don't refuse to operate during a restart-loop crisis.
    const r = await capture(
        $`docker compose ps --status running --status restarting --services`,
    );
    const running = new Set(
        r.ok ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [],
    );
    return classifyStackUp(services, running);
}

// ---------- preflight_ipv6_routing ----------

export interface Ipv6PreflightResult {
    readonly action: "skipped" | "ok" | "fixed" | "warn";
    readonly detail: string;
}

const IPV6_SYSCTL_PATH = "/etc/sysctl.d/99-disable-ipv6.conf";
const DOCKER_DAEMON_PATH = "/etc/docker/daemon.json";
const DOCKER_IPV4_DNS = ["1.1.1.1", "8.8.8.8"] as const;
const IPV6_SYSCTL_CONTENT = `# auto-written by ct preflight because Docker/Rust builds
# can fail on hosts with broken IPv6 routing. Remove to re-enable
# after also setting /etc/docker/daemon.json ipv6=true intentionally.
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 1
`;

export type DockerDaemonIpv4OnlyMerge =
    | { readonly ok: true; readonly text: string; readonly changed: boolean; readonly ipv6Disabled: boolean }
    | { readonly ok: false; readonly detail: string };

export function mergeDockerDaemonIpv4Only(existing: string | null): DockerDaemonIpv4OnlyMerge {
    let config: Record<string, unknown> = {};
    const trimmed = existing?.trim();
    if (trimmed) {
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                return { ok: false, detail: `${DOCKER_DAEMON_PATH} must contain a JSON object` };
            }
            config = { ...(parsed as Record<string, unknown>) };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, detail: `${DOCKER_DAEMON_PATH} is not valid JSON: ${msg}` };
        }
    }

    config["ipv6"] = false;
    if (!Array.isArray(config["dns"]) || config["dns"].length === 0) {
        config["dns"] = [...DOCKER_IPV4_DNS];
    }

    const text = JSON.stringify(config, null, 2) + "\n";
    return {
        ok: true,
        text,
        changed: existing !== text,
        ipv6Disabled: config["ipv6"] === false,
    };
}

export function dockerDaemonDisablesIpv6(existing: string | null): boolean {
    const trimmed = existing?.trim();
    if (!trimmed) return false;
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        return !!parsed
            && typeof parsed === "object"
            && !Array.isArray(parsed)
            && (parsed as Record<string, unknown>)["ipv6"] === false;
    } catch {
        return false;
    }
}

async function readOptionalText(path: string): Promise<string | null> {
    try {
        if (!(await Bun.file(path).exists())) return null;
        return await Bun.file(path).text();
    } catch {
        return null;
    }
}

async function ensureDockerIpv4Only(): Promise<{ ok: boolean; detail?: string }> {
    try {
        await Bun.write(IPV6_SYSCTL_PATH, IPV6_SYSCTL_CONTENT);
        const sysctl = await capture($`sysctl --system`);
        if (!sysctl.ok) {
            return {
                ok: false,
                detail: `sysctl --system failed: ${sysctl.stderr.trim().split("\n")[0] ?? `exit ${sysctl.code}`}`,
            };
        }

        mkdirSync("/etc/docker", { recursive: true });
        const existing = await readOptionalText(DOCKER_DAEMON_PATH);
        const merged = mergeDockerDaemonIpv4Only(existing);
        if (!merged.ok) return { ok: false, detail: merged.detail };

        if (merged.changed) {
            await Bun.write(DOCKER_DAEMON_PATH, merged.text);
            const restart = await capture($`systemctl restart docker`);
            if (!restart.ok) {
                return {
                    ok: false,
                    detail: `systemctl restart docker failed: ${restart.stderr.trim().split("\n")[0] ?? `exit ${restart.code}`}`,
                };
            }
        }

        return {
            ok: true,
            detail: merged.changed
                ? "wrote Docker ipv6=false and restarted docker"
                : "Docker already had ipv6=false",
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, detail: msg };
    }
}

// Pure: classify the outcome of the detect/fix steps. Exported so
// tests can drive every branch without shelling out.
export function classifyIpv6Preflight(input: {
    readonly skipEnv: boolean;
    readonly sysctlPresent: boolean;
    readonly hasGlobalIpv6: boolean;
    readonly canDetect: boolean;
    readonly dockerDaemonIpv6Disabled?: boolean;
    readonly rustStaticIpv4Ok?: boolean;
    readonly fixResult: { ok: boolean; detail?: string } | null;
}): Ipv6PreflightResult {
    if (input.skipEnv) {
        return { action: "skipped", detail: "CT_SKIP_IPV6_AUTO_DISABLE=1" };
    }
    if (!input.canDetect) {
        return { action: "skipped", detail: "`curl` not on PATH; skipping IPv6 build-network probe" };
    }

    const dockerDaemonIpv6Disabled = input.dockerDaemonIpv6Disabled ?? input.sysctlPresent;
    if (input.sysctlPresent && !dockerDaemonIpv6Disabled) {
        if (!input.fixResult) {
            return {
                action: "warn",
                detail: "IPv6 sysctl override exists, but Docker daemon is not pinned to ipv4-only; Rust build may still fail inside BuildKit.",
            };
        }
        if (input.fixResult.ok) {
            return {
                action: "fixed",
                detail: `Docker daemon pinned to ipv4-only (${input.fixResult.detail ?? "ok"})`,
            };
        }
        return {
            action: "warn",
            detail: `Docker IPv6 auto-fix failed (${input.fixResult.detail ?? "unknown"}). Add {"ipv6": false, "dns": ["1.1.1.1", "8.8.8.8"]} to /etc/docker/daemon.json, restart Docker, then rerun ./ct update.`,
        };
    }

    if ((input.sysctlPresent && dockerDaemonIpv6Disabled) || input.hasGlobalIpv6) {
        return { action: "ok", detail: "IPv6 routing OK (or already disabled)" };
    }
    if (input.rustStaticIpv4Ok === false) {
        return {
            action: "warn",
            detail: "static.rust-lang.org is not reachable over IPv4; Rust build cannot download toolchain components. Check VPS outbound HTTPS/DNS, then rerun ./ct update.",
        };
    }
    if (!input.fixResult) {
        return { action: "warn", detail: "IPv6 broken but auto-fix not attempted" };
    }
    if (input.fixResult.ok) {
        return {
            action: "fixed",
            detail: "IPv6 disabled at sysctl + docker daemon (Rust build will use IPv4)",
        };
    }
    return {
        action: "warn",
        detail: `IPv6 auto-fix failed (${input.fixResult.detail ?? "unknown"}); Rust build may fail. Disable broken IPv6 manually or rerun ./ct update after fixing host routing.`,
    };
}

// Pre-flight equivalent of scripts/lib.sh::disable_ipv6_if_broken,
// invoked by `./ct update`. This helper is the BEFORE-the-rust-build
// version that prevents the failure that ate ~30 minutes on a Vultr
// deploy 2026-05-15.
//
// Detection looks for the risky state: no global IPv6 route and no
// sysctl override already in place.
export async function checkIpv6Routing(): Promise<Ipv6PreflightResult> {
    const skipEnv = process.env["CT_SKIP_IPV6_AUTO_DISABLE"] === "1";
    if (skipEnv) {
        return classifyIpv6Preflight({
            skipEnv,
            sysctlPresent: false,
            hasGlobalIpv6: false,
            canDetect: false,
            fixResult: null,
        });
    }

    const sysctlPresent = await Bun.file(IPV6_SYSCTL_PATH).exists();
    const dockerDaemonText = await readOptionalText(DOCKER_DAEMON_PATH);
    const dockerDaemonIpv6Disabled = dockerDaemonDisablesIpv6(dockerDaemonText);

    if (!(await which("curl"))) {
        return classifyIpv6Preflight({
            skipEnv: false,
            sysctlPresent,
            hasGlobalIpv6: false,
            canDetect: false,
            dockerDaemonIpv6Disabled,
            fixResult: null,
        });
    }

    const rustStaticIpv4 = await capture(
        $`curl -4 -sS --connect-timeout 5 --max-time 10 -o /dev/null https://static.rust-lang.org/`,
    );
    const rustStaticIpv6 = await capture(
        $`curl -6 -sS --connect-timeout 5 --max-time 10 -o /dev/null https://static.rust-lang.org/`,
    );

    const alreadyIpv4Only = sysctlPresent && dockerDaemonIpv6Disabled;
    const needsDockerDaemonFix = sysctlPresent && !dockerDaemonIpv6Disabled;
    const needsBrokenIpv6Fix = !alreadyIpv4Only && !rustStaticIpv6.ok && rustStaticIpv4.ok;
    if (!needsDockerDaemonFix && !needsBrokenIpv6Fix) {
        return classifyIpv6Preflight({
            skipEnv: false,
            sysctlPresent,
            hasGlobalIpv6: rustStaticIpv6.ok,
            canDetect: true,
            dockerDaemonIpv6Disabled,
            rustStaticIpv4Ok: rustStaticIpv4.ok,
            fixResult: null,
        });
    }

    const fixResult = await ensureDockerIpv4Only();

    return classifyIpv6Preflight({
        skipEnv: false,
        sysctlPresent,
        hasGlobalIpv6: rustStaticIpv6.ok,
        canDetect: true,
        dockerDaemonIpv6Disabled,
        rustStaticIpv4Ok: rustStaticIpv4.ok,
        fixResult,
    });
}
