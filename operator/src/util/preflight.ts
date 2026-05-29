// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/preflight.ts — pre-flight checks for the
// update / install / restore scripts.
//
// Mirrors scripts/lib.sh's preflight_* helpers. Each check returns
// a structured `PreflightResult` so callers can decide whether to
// die() or warn() or accumulate failures. Pure logic (free-space
// math, threshold compare) is split into named helpers so it can
// be unit-tested without spawning subprocesses.

import { $, capture, which } from "./sh";
import type { DiagFailure } from "./diag";

export type PreflightResult =
    | { readonly ok: true; readonly summary?: string }
    | { readonly ok: false; readonly failure: DiagFailure };

// ---------- preflight_network ----------

const DEFAULT_NETWORK_HOSTS = ["github.com"] as const;

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
            diag: `Update needs to git pull and download release assets from
github.com. It is unreachable from this VPS.

What to check (in priority order):
  ping -c 3 1.1.1.1                  # internet reachable at all?
  dig +short github.com              # DNS resolving?
  curl -v https://github.com/        # outbound 443 not blocked?
  printenv HTTPS_PROXY               # corporate proxy needed?
  ./scripts/fetch_image_bundle.sh     # release asset fetch path

When the network is back, re-run:
  ./ct update`,
        },
    };
}

async function defaultNetworkProbe(host: string): Promise<boolean> {
    // Retry transient failures (timeouts, refused/reset connections, transient
    // 5xx) so a momentary blip on a flaky or throttled VPS link doesn't abort
    // install/update. No -f: any HTTP response means the round trip completed,
    // which is all this reachability gate needs.
    const r = await capture(
        $`curl -sS --connect-timeout 5 --max-time 10 --retry 2 --retry-delay 2 --retry-connrefused -o /dev/null https://${host}/`,
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
    // df -k columns: Filesystem | 1K-blocks | Used | Available | Use% | Mounted on
    // When the Filesystem name is long, GNU df wraps it onto its own line and
    // puts the numeric columns on the next line. Join the data rows (everything
    // after the header) so the six fields line up regardless of wrapping.
    const tokens = lines.slice(1).join(" ").trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 6) return null;
    const n = parseInt(tokens[3]!, 10);
    return Number.isFinite(n) ? n : null;
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
                diag: `Git pull, release bundle download, and docker load all need
scratch space; running out mid-update leaves partial image state.

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
                diag: `Docker loads release image layers under ${m.dockerRoot}.
Out-of-space during docker load typically surfaces as 'no space left on
device', leaving an incomplete local image set.

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
    docker compose up -d --no-build --pull never
                                      # bring it back up from release images
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

// ---------- preflight_ipv4_only ----------

export interface Ipv4OnlyPreflightResult {
    readonly action: "skipped" | "ok" | "fixed" | "warn";
    readonly detail: string;
}

const DOCKER_DAEMON_PATH = "/etc/docker/daemon.json";
const DOCKER_IPV4_DNS = ["1.1.1.1", "8.8.8.8"] as const;

export type DockerDaemonIpv4OnlyMerge =
    | { readonly ok: true; readonly text: string; readonly changed: boolean; readonly dockerIpv4Only: boolean }
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
        dockerIpv4Only: config["ipv6"] === false,
    };
}

export function dockerDaemonIsIpv4Only(existing: string | null): boolean {
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

// Pure: classify the outcome of the detect/fix steps. Exported so
// tests can drive every branch without shelling out.
export function classifyIpv4OnlyPreflight(input: {
    readonly skipEnv: boolean;
    readonly sysctlPresent: boolean;
    readonly hasGlobalRoute: boolean;
    readonly canDetect: boolean;
    readonly dockerDaemonIpv4Only?: boolean;
    readonly rustStaticIpv4Ok?: boolean;
    readonly fixResult: { ok: boolean; detail?: string } | null;
}): Ipv4OnlyPreflightResult {
    if (input.skipEnv) {
        return { action: "skipped", detail: "CT_SKIP_IPV6_AUTO_DISABLE=1" };
    }

    const dockerDaemonIpv4Only = input.dockerDaemonIpv4Only ?? input.sysctlPresent;
    const alreadyIpv4Only = input.sysctlPresent && dockerDaemonIpv4Only;
    if (!input.fixResult) {
        if (alreadyIpv4Only) {
            return { action: "ok", detail: "IPv4-only already enforced (IPv4-only sysctl + Docker daemon config)" };
        }
        if (!input.canDetect) {
            return { action: "warn", detail: "IPv4-only preflight did not run; `curl` is missing and Docker/Rust may still use non-IPv4 routes." };
        }
        return { action: "warn", detail: "IPv4-only preflight did not run; Docker/Rust may still use non-IPv4 routes." };
    }

    if (!input.fixResult.ok) {
        return {
            action: "warn",
            detail: `IPv4-only enforcement failed (${input.fixResult.detail ?? "unknown"}). Add {"ipv6": false, "dns": ["1.1.1.1", "8.8.8.8"]} to /etc/docker/daemon.json, restart Docker, then rerun ./ct update.`,
        };
    }

    if (input.rustStaticIpv4Ok === false) {
        return {
            action: "warn",
            detail: "IPv4-only enforced, but static.rust-lang.org is not reachable over IPv4. Check VPS outbound HTTPS/DNS, then rerun ./ct update.",
        };
    }

    if (input.sysctlPresent && !dockerDaemonIpv4Only) {
        if (input.fixResult.ok) {
            return {
                action: "fixed",
                detail: `Docker daemon pinned to ipv4-only (${input.fixResult.detail ?? "ok"})`,
            };
        }
    }

    return {
        action: alreadyIpv4Only ? "ok" : "fixed",
        detail: `IPv4-only enforced (${input.fixResult.detail ?? "ok"})`,
    };
}
