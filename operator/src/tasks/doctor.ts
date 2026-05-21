// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/doctor.ts — TS port of ct doctor.
//
// PASS/WARN/FAIL dashboard, grouped by area. Non-zero exit only on FAIL;
// WARN-only runs exit zero. No state mutation — safe on a healthy VPS.

import { hostname } from "node:os";
import { stat } from "node:fs/promises";
import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { $, capture, which } from "../util/sh";
import { loadDotenv, mergeEnv, type EnvMap } from "../util/env";

type Severity = "pass" | "warn" | "fail" | "info";

interface CheckLine {
    group: string;
    label: string;
    severity: Severity;
    detail: string;
    hint?: string;
}

const G_PREREQ = "Prerequisites";
const G_STRUCT = "Structural (network reachability)";
const G_APP = "Application";
const G_COMPOSE = "Compose stack";
const G_RES = "Resources";
const G_LATENCY = "Latency diagnostics";
const G_INFO = "Info (no PASS/FAIL contribution)";
const G_ERR = "Errors";

const isTty = process.stdout.isTTY === true;
const COLOR: Record<Severity, string> = isTty
    ? { pass: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m", info: "\x1b[1m" }
    : { pass: "", warn: "", fail: "", info: "" };
const RESET = isTty ? "\x1b[0m" : "";
const BOLD = isTty ? "\x1b[1m" : "";

function tag(sev: Severity): string {
    return `${COLOR[sev]}[${sev.toUpperCase()}]${RESET}`;
}

function emit(line: CheckLine): void {
    const padded = line.label.padEnd(14);
    process.stdout.write(`  ${tag(line.severity)} ${padded} ${line.detail}\n`);
}

interface CheckCtx {
    readonly run: RunContext;
    readonly env: EnvMap;
}

type CheckFn = (c: CheckCtx) => Promise<CheckLine>;
type ComposePsRow = Record<string, string>;

export function indexComposeRowsByService(output: string): Map<string, ComposePsRow> {
    const rowsByService = new Map<string, ComposePsRow>();
    for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            const service = parsed["Service"];
            if (typeof service === "string" && service !== "" && !rowsByService.has(service)) {
                rowsByService.set(service, parsed as ComposePsRow);
            }
        } catch {
            // Ignore malformed compose rows; the health check reports missing services below.
        }
    }

    return rowsByService;
}

// ---------- individual checks (port of doctor.sh) -------------------------

async function checkComposeAvailable(_c: CheckCtx): Promise<CheckLine> {
    if (await which("docker")) {
        const r = await capture($`docker compose version --short`);
        if (r.ok && r.stdout.trim()) {
            return { group: G_PREREQ, label: "compose", severity: "pass", detail: `v${r.stdout.trim()}` };
        }
    }
    return {
        group: G_PREREQ,
        label: "compose",
        severity: "fail",
        detail: "docker compose v2 not on PATH",
        hint: "Install: apt install -y docker-compose-plugin",
    };
}

async function checkEnvFile(c: CheckCtx): Promise<CheckLine> {
    const envPath = `${c.run.cwd}/.env`;
    try {
        const st = await stat(envPath);
        const mode = (st.mode & 0o777).toString(8).padStart(3, "0");
        const lastDigit = Number(mode.slice(-1));
        if (lastDigit >= 4) {
            return {
                group: G_PREREQ,
                label: ".env",
                severity: "warn",
                detail: `present, mode ${mode} is world-readable`,
                hint: "chmod 0600 .env",
            };
        }
        return { group: G_PREREQ, label: ".env", severity: "pass", detail: `present, mode ${mode}` };
    } catch {
        return {
            group: G_PREREQ,
            label: ".env",
            severity: "fail",
            detail: "missing",
            hint: "cp .env.example .env && $EDITOR .env",
        };
    }
}

async function checkDns(c: CheckCtx): Promise<CheckLine> {
    const domain = c.env["DOMAIN"];
    if (!domain) {
        return {
            group: G_STRUCT,
            label: "DNS",
            severity: "fail",
            detail: "DOMAIN unset in .env",
            hint: "Set DOMAIN= in .env and re-run",
        };
    }
    const dig = await capture($`dig +short A ${domain}`);
    const resolved = dig.ok ? (dig.stdout.trim().split("\n")[0]?.trim() ?? "") : "";
    const ipR = await capture($`curl -s4 --max-time 4 https://ifconfig.co`);
    const myIp = ipR.stdout.trim();
    if (resolved && resolved === myIp) {
        return { group: G_STRUCT, label: "DNS", severity: "pass", detail: `${domain} -> ${resolved} (matches host IP)` };
    }
    if (resolved && myIp) {
        return {
            group: G_STRUCT,
            label: "DNS",
            severity: "fail",
            detail: `${domain} resolves to ${resolved}, host IP is ${myIp}`,
            hint: `Update DNS A record to ${myIp}, then wait for propagation`,
        };
    }
    return {
        group: G_STRUCT,
        label: "DNS",
        severity: "warn",
        detail: "could not resolve DOMAIN or determine host IP",
        hint: `dig +short A ${domain}; curl -s4 https://ifconfig.co`,
    };
}

async function checkPorts(_c: CheckCtx): Promise<CheckLine> {
    const r = await capture($`ss -ltn`);
    if (!r.ok) {
        return { group: G_STRUCT, label: "Ports", severity: "warn", detail: "ss not available" };
    }
    const localAddrs = r.stdout.split("\n").map((l) => l.trim().split(/\s+/)[3] ?? "").filter(Boolean);
    const p80 = localAddrs.some((a) => a.endsWith(":80")) ? "ok" : "ng";
    const p443 = localAddrs.some((a) => a.endsWith(":443")) ? "ok" : "ng";
    if (p80 === "ok" && p443 === "ok") {
        return { group: G_STRUCT, label: "Ports", severity: "pass", detail: "80/tcp and 443/tcp listening" };
    }
    if (p80 === "ok" || p443 === "ok") {
        return {
            group: G_STRUCT,
            label: "Ports",
            severity: "warn",
            detail: `partial: 80=${p80} 443=${p443}`,
            hint: "docker compose ps caddy; docker compose logs --tail=40 caddy",
        };
    }
    return {
        group: G_STRUCT,
        label: "Ports",
        severity: "fail",
        detail: "neither 80 nor 443 listening",
        hint: "docker compose up -d caddy; check Caddyfile + ACME state",
    };
}

async function checkAcmeCert(c: CheckCtx): Promise<CheckLine> {
    const domain = c.env["PANEL_DOMAIN"] || (c.env["DOMAIN"] ? `panel.${c.env["DOMAIN"]}` : "");
    if (!domain) {
        return { group: G_STRUCT, label: "ACME cert", severity: "warn", detail: "skipped (PANEL_DOMAIN and DOMAIN unset)" };
    }
    const probe = await capture(
        $`bash -c "echo | timeout 6 openssl s_client -servername ${domain} -connect ${domain}:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null"`,
    );
    const out = probe.stdout.trim();
    if (!out) {
        return {
            group: G_STRUCT,
            label: "ACME cert",
            severity: "fail",
            detail: `could not retrieve cert from ${domain}:443`,
            hint: "docker compose logs --tail=40 caddy | grep -iE 'acme|cert'",
        };
    }
    const enddate = out.replace(/^.*notAfter=/, "").trim();
    const expiryMs = Date.parse(enddate);
    if (!isFinite(expiryMs)) {
        return { group: G_STRUCT, label: "ACME cert", severity: "warn", detail: `expiry parse failed: ${enddate}` };
    }
    const daysLeft = Math.floor((expiryMs - Date.now()) / (86400 * 1000));
    if (daysLeft < 7) {
        return {
            group: G_STRUCT,
            label: "ACME cert",
            severity: "fail",
            detail: `expires in ${daysLeft} days`,
            hint: "Force renewal: docker compose restart caddy; check ACME challenge reachable",
        };
    }
    if (daysLeft < 14) {
        return {
            group: G_STRUCT,
            label: "ACME cert",
            severity: "warn",
            detail: `expires in ${daysLeft} days (renews automatically at <30)`,
            hint: "Monitor: docker compose logs --tail=80 caddy | grep -iE 'acme|cert'",
        };
    }
    return { group: G_STRUCT, label: "ACME cert", severity: "pass", detail: `valid, expires in ${daysLeft} days` };
}

async function checkUpEndpoint(_c: CheckCtx): Promise<CheckLine> {
    const r = await capture(
        $`curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:9000/up`,
    );
    const code = r.stdout.trim() || "000";
    if (code === "200") {
        return { group: G_APP, label: "/up endpoint", severity: "pass", detail: "HTTP 200 from FrankenPHP" };
    }
    if (code === "000") {
        return {
            group: G_APP,
            label: "/up endpoint",
            severity: "fail",
            detail: "connection failed (port 9000 not reachable)",
            hint: "docker compose ps panel; docker compose logs --tail=60 panel",
        };
    }
    return {
        group: G_APP,
        label: "/up endpoint",
        severity: "fail",
        detail: `HTTP ${code} (expected 200)`,
        hint: "docker compose logs --tail=60 panel",
    };
}

type CurlTiming = {
    code: string;
    connectMs: number;
    tlsMs: number;
    ttfbMs: number;
    totalMs: number;
    remote: string;
};

function parseCurlTiming(out: string): CurlTiming | null {
    const fields = Object.fromEntries(
        out.trim().split(/\s+/)
            .map((part) => {
                const i = part.indexOf("=");
                return i > 0 ? [part.slice(0, i), part.slice(i + 1)] : null;
            })
            .filter((x): x is [string, string] => x !== null),
    );
    const seconds = (key: string): number => {
        const n = Number(fields[key] ?? "0");
        return Number.isFinite(n) ? Math.round(n * 1000) : 0;
    };
    if (!fields["code"]) return null;
    return {
        code: fields["code"],
        connectMs: seconds("connect"),
        tlsMs: seconds("tls"),
        ttfbMs: seconds("ttfb"),
        totalMs: seconds("total"),
        remote: fields["remote"] ?? "",
    };
}

async function curlTiming(url: string): Promise<CurlTiming | null> {
    const fmt = "code=%{http_code} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} remote=%{remote_ip}";
    const r = await capture(
        $`curl -4 -sS -o /dev/null -w ${fmt} --connect-timeout 4 --max-time 8 ${url}`,
    );
    const parsed = parseCurlTiming(r.stdout);
    if (!r.ok && parsed?.code === "000") return parsed;
    return parsed;
}

async function checkVpsEgressLatency(_c: CheckCtx): Promise<CheckLine> {
    const t = await curlTiming("https://www.cloudflare.com/cdn-cgi/trace");
    if (!t) {
        return {
            group: G_LATENCY,
            label: "VPS egress",
            severity: "warn",
            detail: "could not measure Cloudflare over IPv4",
            hint: "curl -4 -w '%{time_total}\\n' https://www.cloudflare.com/cdn-cgi/trace",
        };
    }
    const detail = `cf total=${t.totalMs}ms tls=${t.tlsMs}ms ttfb=${t.ttfbMs}ms remote=${t.remote || "?"}`;
    if (t.code === "000" || t.totalMs > 1500) {
        return {
            group: G_LATENCY,
            label: "VPS egress",
            severity: "fail",
            detail,
            hint: "Check VPS provider egress, DNS, and firewall; compare curl -4 to several sites",
        };
    }
    if (t.totalMs > 500) {
        return {
            group: G_LATENCY,
            label: "VPS egress",
            severity: "warn",
            detail,
            hint: "VPS outbound is slower than expected; compare provider region and route",
        };
    }
    return { group: G_LATENCY, label: "VPS egress", severity: "pass", detail };
}

async function checkPanelPublicLatency(c: CheckCtx): Promise<CheckLine> {
    const domain = c.env["PANEL_DOMAIN"] || (c.env["DOMAIN"] ? `panel.${c.env["DOMAIN"]}` : "");
    if (!domain) {
        return { group: G_LATENCY, label: "Panel RTT", severity: "warn", detail: "skipped (PANEL_DOMAIN and DOMAIN unset)" };
    }
    const t = await curlTiming(`https://${domain}/up`);
    if (!t) {
        return {
            group: G_LATENCY,
            label: "Panel RTT",
            severity: "warn",
            detail: "could not measure public /up endpoint",
            hint: `curl -4 -w '%{time_total}\\n' https://${domain}/up`,
        };
    }
    const detail = `/up total=${t.totalMs}ms connect=${t.connectMs}ms tls=${t.tlsMs}ms ttfb=${t.ttfbMs}ms`;
    if (t.code !== "200") {
        return {
            group: G_LATENCY,
            label: "Panel RTT",
            severity: "warn",
            detail: `HTTP ${t.code}; ${detail}`,
            hint: `curl -vk https://${domain}/up`,
        };
    }
    if (t.totalMs > 1500) {
        return {
            group: G_LATENCY,
            label: "Panel RTT",
            severity: "warn",
            detail,
            hint: "High panel RTT means client-to-VPS route is slow before the tunnel does any work",
        };
    }
    return { group: G_LATENCY, label: "Panel RTT", severity: "pass", detail };
}

async function checkSingboxDirectStrategy(_c: CheckCtx): Promise<CheckLine> {
    const r = await capture(
        $`docker compose exec -T panel jq -rc '.outbounds[]? | select(.type=="direct" and .tag=="direct")' /data/config/singbox.json`,
    );
    if (!r.ok || !r.stdout.trim()) {
        return {
            group: G_LATENCY,
            label: "Direct dial",
            severity: "warn",
            detail: "could not read rendered direct outbound",
            hint: "docker compose exec -T panel jq '.outbounds' /data/config/singbox.json",
        };
    }
    try {
        const direct = JSON.parse(r.stdout.trim().split("\n")[0]!) as Record<string, unknown>;
        const strategy = String(direct["domain_strategy"] ?? "");
        const connect = String(direct["connect_timeout"] ?? "");
        const fallback = String(direct["fallback_delay"] ?? "");
        const detail = strategy
            ? `domain_strategy=${strategy} connect_timeout=${connect || "-"} fallback_delay=${fallback || "-"}`
            : "no domain_strategy in rendered direct outbound";
        if (strategy === "prefer_ipv4" || strategy === "ipv4_only") {
            return { group: G_LATENCY, label: "Direct dial", severity: "pass", detail };
        }
        return {
            group: G_LATENCY,
            label: "Direct dial",
            severity: "warn",
            detail,
            hint: "Set SINGBOX_DIRECT_DOMAIN_STRATEGY=prefer_ipv4 or ipv4_only, then ./ct render singbox",
        };
    } catch {
        return {
            group: G_LATENCY,
            label: "Direct dial",
            severity: "warn",
            detail: "rendered direct outbound is not valid JSON",
            hint: "docker compose exec -T panel jq '.outbounds' /data/config/singbox.json",
        };
    }
}

async function checkContainerHealth(_c: CheckCtx): Promise<CheckLine> {
    // v0.4.0+: caddy + singbox + panel + db + redis. Caddy is the
    // public SNI splitter; singbox is the VLESS+Reality proxy behind it.
    const services = ["caddy", "singbox", "panel", "db", "redis"];
    const ps = await capture($`docker compose ps --format json`);
    if (!ps.ok || !ps.stdout.trim()) {
        return {
            group: G_COMPOSE,
            label: "Containers",
            severity: "fail",
            detail: "docker compose ps returned nothing",
            hint: "From the repo root: docker compose ps",
        };
    }
    const rowsByService = indexComposeRowsByService(ps.stdout);
    let healthy = 0;
    const missing: string[] = [];
    const unhealthy: string[] = [];
    for (const svc of services) {
        const row = rowsByService.get(svc);
        if (!row) { missing.push(svc); continue; }
        const state = row["State"] ?? "unknown";
        const health = row["Health"] ?? "";
        if (state === "running" && (!health || health === "healthy")) {
            healthy++;
        } else {
            unhealthy.push(`${svc}=${state}${health ? "/" + health : ""}`);
        }
    }
    const total = services.length;
    if (missing.length === 0 && unhealthy.length === 0) {
        return { group: G_COMPOSE, label: "Containers", severity: "pass", detail: `${healthy}/${total} running` };
    }
    if (healthy === 0) {
        return {
            group: G_COMPOSE,
            label: "Containers",
            severity: "fail",
            detail: `0/${total} running`,
            hint: "docker compose up -d; docker compose logs --tail=80",
        };
    }
    let msg = `${healthy}/${total} running`;
    if (missing.length > 0) msg += `, missing: ${missing.join(",")}`;
    if (unhealthy.length > 0) msg += `, degraded: ${unhealthy.join(",")}`;
    const tail = [...missing, ...unhealthy.map((u) => u.split("=")[0])].filter(Boolean).join(" ");
    return {
        group: G_COMPOSE,
        label: "Containers",
        severity: "warn",
        detail: msg,
        hint: `docker compose ps; docker compose logs --tail=40 ${tail}`,
    };
}

async function checkSupervisord(_c: CheckCtx): Promise<CheckLine> {
    const r = await capture($`docker compose exec -T panel supervisorctl status`);
    if (!r.ok) {
        return {
            group: G_COMPOSE,
            label: "Supervisord",
            severity: "warn",
            detail: "could not query supervisorctl in panel",
            hint: "docker compose ps panel; docker compose exec panel supervisorctl status",
        };
    }
    const lines = r.stdout.split("\n").filter((l) => l.trim());
    const total = lines.length;
    const running = lines.filter((l) => l.split(/\s+/)[1] === "RUNNING").length;
    if (running === 5 && total === 5) {
        return { group: G_COMPOSE, label: "Supervisord", severity: "pass", detail: "5/5 programs running" };
    }
    if (running > 0) {
        return {
            group: G_COMPOSE,
            label: "Supervisord",
            severity: "warn",
            detail: `${running}/${total} programs running`,
            hint: "docker compose exec panel supervisorctl status",
        };
    }
    return {
        group: G_COMPOSE,
        label: "Supervisord",
        severity: "fail",
        detail: `0/${total} programs running`,
        hint: "docker compose logs --tail=80 panel",
    };
}

function parseDfAvailKb(out: string): number {
    const line = out.trim().split("\n")[1];
    if (!line) return 0;
    const cols = line.split(/\s+/);
    return Number(cols[3] ?? 0) || 0;
}

async function checkDisk(_c: CheckCtx): Promise<CheckLine> {
    const repo = await capture($`df -k .`);
    const repoGb = Math.floor(parseDfAvailKb(repo.stdout) / 1024 / 1024);
    const dockerRoot = await capture($`docker info --format ${"{{.DockerRootDir}}"}`);
    const root = dockerRoot.ok && dockerRoot.stdout.trim() ? dockerRoot.stdout.trim() : "/var/lib/docker";
    const dockerDf = await capture($`df -k ${root}`);
    const dockerGb = Math.floor(parseDfAvailKb(dockerDf.stdout) / 1024 / 1024);
    const repoMin = Number(process.env["CT_MIN_REPO_GB"] ?? 2);
    const dockerMin = Number(process.env["CT_MIN_DOCKER_GB"] ?? 4);
    if (repoGb < repoMin || dockerGb < dockerMin) {
        return {
            group: G_RES,
            label: "Disk",
            severity: "fail",
            detail: `repo ${repoGb}G, docker ${dockerGb}G (need >= ${repoMin}/${dockerMin})`,
            hint: "docker system prune -af; docker builder prune -af; rm -rf core/target",
        };
    }
    if (repoGb < repoMin * 2 || dockerGb < dockerMin * 2) {
        return {
            group: G_RES,
            label: "Disk",
            severity: "warn",
            detail: `repo ${repoGb}G, docker ${dockerGb}G (tight)`,
            hint: "docker system prune -af  # reclaim 1-5 GB typical",
        };
    }
    return { group: G_RES, label: "Disk", severity: "pass", detail: `repo ${repoGb}G, docker ${dockerGb}G` };
}

async function checkRam(_c: CheckCtx): Promise<CheckLine> {
    try {
        const text = await Bun.file("/proc/meminfo").text();
        const get = (k: string): number => {
            const m = text.match(new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, "m"));
            return m && m[1] ? Number(m[1]) : 0;
        };
        const total = get("MemTotal");
        const avail = get("MemAvailable");
        const totalMb = Math.floor(total / 1024);
        const availMb = Math.floor(avail / 1024);
        const pct = total > 0 ? Math.floor((avail * 100) / total) : 0;
        if (pct < 10) {
            return {
                group: G_RES,
                label: "RAM",
                severity: "fail",
                detail: `${availMb}M / ${totalMb}M free (${pct}%)`,
                hint: "docker stats --no-stream; consider docker system prune -af",
            };
        }
        if (pct < 25) {
            return {
                group: G_RES,
                label: "RAM",
                severity: "warn",
                detail: `${availMb}M / ${totalMb}M free (${pct}%)`,
                hint: "docker stats --no-stream  # which container is hot?",
            };
        }
        return { group: G_RES, label: "RAM", severity: "pass", detail: `${availMb}M / ${totalMb}M free (${pct}%)` };
    } catch {
        return { group: G_RES, label: "RAM", severity: "warn", detail: "/proc/meminfo unreadable (non-Linux host?)" };
    }
}

async function infoReleaseVersion(_c: CheckCtx): Promise<CheckLine> {
    const r = await capture(
        $`bash -c "docker compose exec -T panel ct-server-core --json version 2>/dev/null | jq -r '.version // \"?\"'"`,
    );
    const v = r.ok && r.stdout.trim() ? r.stdout.trim() : "?";
    return { group: G_INFO, label: "Release", severity: "info", detail: `v${v}` };
}

async function infoActiveUsers(_c: CheckCtx): Promise<CheckLine> {
    // v0.1.12 unnested the shell layering. Pre-this-fix the snippet
    // travelled through Bun's $ template → bash -c → tinker
    // --execute's single-quoted argv → PHP, with eight-deep
    // backslash escaping for the `\App\Models\ProxyAccount`
    // namespace path. Reality on a live deploy: PHP received a
    // string beginning with bare `\` and emitted
    // `T_NS_SEPARATOR on line 1`. The `tr -d` then folded the
    // multi-line PHP error onto the info banner. Passing the
    // PHP snippet as a single argv arg lets Bun shell-escape it
    // properly; PHP's tinker resolves `App\Models\ProxyAccount`
    // in the global namespace just fine without a leading
    // backslash.
    const snippet = "echo App\\Models\\ProxyAccount::where('enabled', true)->count();";
    const r = await capture(
        $`docker compose exec -T panel php artisan tinker --execute=${snippet}`,
    );
    const n = r.ok ? r.stdout.replace(/\s+/g, "") : "?";
    return { group: G_INFO, label: "Active users", severity: "info", detail: `${n || "?"} proxy accounts enabled` };
}

async function infoMessengerDepth(c: CheckCtx): Promise<CheckLine> {
    const pw = c.env["REDIS_PASSWORD"];
    if (!pw) {
        return { group: G_INFO, label: "Msgr depth", severity: "info", detail: "skipped (REDIS_PASSWORD unset in .env)" };
    }
    // v0.1.14 hardened against the v0.1.12 bug class. Pre-fix the
    // password was interpolated INTO a `bash -c "..."` quoted string
    // (`-e REDISCLI_AUTH=${pw}`). Bun shell-escaped it as a single
    // arg, but bash then re-parsed the resulting command line; a
    // password containing `$`, backtick, or `"` would corrupt
    // tokenisation. Now `docker compose exec -e REDISCLI_AUTH`
    // takes no value — it imports REDISCLI_AUTH from the calling
    // shell's env, which Bun's $.env() sets cleanly. The secret
    // never appears in argv.
    const r = await capture(
        $`docker compose exec -T -e REDISCLI_AUTH redis redis-cli XLEN cool_tunnel:messenger`
            .env({ ...process.env, REDISCLI_AUTH: pw })
            .quiet(),
    );
    const depth = r.ok && r.stdout.trim() ? r.stdout.trim() : "?";
    return { group: G_INFO, label: "Msgr depth", severity: "info", detail: `${depth} (cool_tunnel:messenger stream)` };
}

const CHECKS: CheckFn[] = [
    checkComposeAvailable,
    checkEnvFile,
    checkDns,
    checkPorts,
    checkAcmeCert,
    checkUpEndpoint,
    checkSingboxDirectStrategy,
    checkVpsEgressLatency,
    checkPanelPublicLatency,
    checkContainerHealth,
    checkSupervisord,
    checkDisk,
    checkRam,
    infoReleaseVersion,
    infoActiveUsers,
    infoMessengerDepth,
];

// ---------- Task ----------------------------------------------------------

export class DoctorTask implements Task {
    readonly name = "doctor";

    async run(ctx: RunContext): Promise<TaskResult> {
        const dotenv = await loadDotenv([`${ctx.cwd}/.env`, `${ctx.cwd}/../.env`]);
        const env = mergeEnv(ctx.env, dotenv?.env ?? null);
        const c: CheckCtx = { run: ctx, env };

        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        process.stdout.write(`${BOLD}Cool Tunnel Server — Doctor${RESET}\n`);
        process.stdout.write(`${BOLD} (date ${ts}, host ${hostname()})${RESET}\n`);

        const grouped = new Map<string, CheckLine[]>();
        let pass = 0, warn = 0, fail = 0, info = 0;
        const remediation: CheckLine[] = [];

        for (const fn of CHECKS) {
            let line: CheckLine;
            try {
                line = await fn(c);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                line = { group: G_ERR, label: fn.name, severity: "fail", detail: `check threw: ${msg}` };
            }
            if (!grouped.has(line.group)) grouped.set(line.group, []);
            grouped.get(line.group)!.push(line);
            if (line.severity === "pass") pass++;
            else if (line.severity === "warn") warn++;
            else if (line.severity === "fail") fail++;
            else if (line.severity === "info") info++;
            if ((line.severity === "warn" || line.severity === "fail") && line.hint) {
                remediation.push(line);
            }
        }

        for (const g of [G_PREREQ, G_STRUCT, G_APP, G_COMPOSE, G_RES, G_LATENCY, G_INFO, G_ERR]) {
            const lines = grouped.get(g);
            if (!lines || lines.length === 0) continue;
            process.stdout.write(`\n${BOLD}${g}${RESET}\n`);
            for (const l of lines) emit(l);
        }

        process.stdout.write(`\n${BOLD}Summary${RESET}\n`);
        process.stdout.write(
            `  ${COLOR.pass}${pass} PASS${RESET}, ${COLOR.warn}${warn} WARN${RESET}, ${COLOR.fail}${fail} FAIL${RESET}, ${info} INFO\n`,
        );

        if (remediation.length > 0) {
            process.stdout.write(`\n${BOLD}Remediation:${RESET}\n`);
            for (const r of remediation) {
                const color = r.severity === "fail" ? COLOR.fail : COLOR.warn;
                process.stdout.write(`\n  ${color}[${r.severity.toUpperCase()}] ${r.label}${RESET}\n`);
                process.stdout.write(`    ${r.detail}\n`);
                process.stdout.write(`    ${BOLD}->${RESET} ${r.hint}\n`);
            }
            process.stdout.write("\n");
        }

        const ok = fail === 0;
        return {
            ok,
            code: ok ? 0 : 1,
            summary: `${pass}P/${warn}W/${fail}F`,
            json: { pass, warn, fail, info, checks: [...grouped.values()].flat() },
        };
    }
}
