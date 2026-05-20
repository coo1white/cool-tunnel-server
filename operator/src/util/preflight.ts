// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/preflight.ts — pre-flight checks for the
// update / install / restore scripts.
//
// Mirrors scripts/lib.sh's preflight_* helpers. Each check returns
// a structured `PreflightResult` so callers can decide whether to
// die() or warn() or accumulate failures. Pure logic (free-space
// math, threshold compare) is split into named helpers so it can
// be unit-tested without spawning subprocesses.

import { $, capture } from "./sh";
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

export async function checkDiskSpace(
    thresholds: DiskSpaceThresholds = DEFAULT_DISK_THRESHOLDS,
): Promise<PreflightResult> {
    const repoDf = await capture($`df -k .`);
    const repoKb = repoDf.ok ? parseDfAvailableKb(repoDf.stdout) ?? 0 : 0;
    const repoGb = kbToGb(repoKb);
    if (repoGb < thresholds.minRepoGb) {
        return {
            ok: false,
            failure: {
                summary: `low disk under repo path: ${repoGb}G free, need >= ${thresholds.minRepoGb}G`,
                diag: `Compose build, git pull, and composer install all need scratch
space; running out mid-update corrupts the build cache.

What to free (priority order, most-impact first):
  docker system prune -af        # stopped containers + dangling images
  docker builder prune -af       # buildkit cache (1-3 GB typical)
  rm -rf core/target             # Rust build cache (2-5 GB)
  du -h --max-depth=1 / | sort -rh | head    # find the actual offender

Re-run ./ct update after freeing space.`,
            },
        };
    }

    const dockerInfo = await capture($`docker info --format ${"{{.DockerRootDir}}"}`);
    const dockerRoot = dockerInfo.ok && dockerInfo.stdout.trim()
        ? dockerInfo.stdout.trim()
        : "/var/lib/docker";
    const dockerDf = await capture($`df -k ${dockerRoot}`);
    const dockerKb = dockerDf.ok ? parseDfAvailableKb(dockerDf.stdout) ?? 0 : 0;
    const dockerGb = kbToGb(dockerKb);
    if (dockerGb < thresholds.minDockerGb) {
        return {
            ok: false,
            failure: {
                summary: `low disk under docker root (${dockerRoot}): ${dockerGb}G free, need >= ${thresholds.minDockerGb}G`,
                diag: `Compose pull + build will store image layers under ${dockerRoot}.
Out-of-space mid-build typically surfaces as 'no space left on
device' partway through, leaving a half-built panel image and a
confused stack.

What to free (priority order):
  docker system prune -af
  docker builder prune -af
  docker volume ls -qf dangling=true | xargs -r docker volume rm
  du -sh ${dockerRoot}/overlay2/*  | sort -rh | head`,
            },
        };
    }

    return { ok: true, summary: `disk space OK (repo: ${repoGb}G, docker: ${dockerGb}G)` };
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

// Pure: classify the outcome of the detect/fix steps. Exported so
// tests can drive every branch without shelling out.
export function classifyIpv6Preflight(input: {
    readonly skipEnv: boolean;
    readonly sysctlPresent: boolean;
    readonly hasGlobalIpv6: boolean;
    readonly canDetect: boolean;
    readonly fixResult: { ok: boolean; detail?: string } | null;
}): Ipv6PreflightResult {
    if (input.skipEnv) {
        return { action: "skipped", detail: "CT_SKIP_IPV6_AUTO_DISABLE=1" };
    }
    if (!input.canDetect) {
        return { action: "skipped", detail: "`ip` not on PATH (non-Linux host?)" };
    }
    if (input.sysctlPresent || input.hasGlobalIpv6) {
        return { action: "ok", detail: "IPv6 routing OK (or already disabled)" };
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

    const sysctlPresent = await Bun.file("/etc/sysctl.d/99-disable-ipv6.conf").exists();
    if (sysctlPresent) {
        return classifyIpv6Preflight({
            skipEnv: false,
            sysctlPresent: true,
            hasGlobalIpv6: false,
            canDetect: true,
            fixResult: null,
        });
    }

    const ip = await capture($`command -v ip`);
    if (!ip.ok) {
        return classifyIpv6Preflight({
            skipEnv: false,
            sysctlPresent: false,
            hasGlobalIpv6: false,
            canDetect: false,
            fixResult: null,
        });
    }

    const route = await capture($`ip -6 route get 2606:4700:4700::1111`);
    if (route.ok) {
        return classifyIpv6Preflight({
            skipEnv: false,
            sysctlPresent: false,
            hasGlobalIpv6: true,
            canDetect: true,
            fixResult: null,
        });
    }

    return classifyIpv6Preflight({
        skipEnv: false,
        sysctlPresent: false,
        hasGlobalIpv6: false,
        canDetect: true,
        fixResult: null,
    });
}
