// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/readiness.ts — TS port of scripts/late-night-comeback.sh.
//
// Ten checks. Pass >= 9/10 to ship. Structural checks 1-4 cap the final
// score at 7 if any of them is NG. Exit 0 on pass, 1 on fail.
//
// On fail with interactive stdin, offer tactical retreat (git checkout
// last-good-tag + compose up -d) or clean rebuild (compose down +
// build --no-cache + up -d). First failure -> retreat; if retreat
// fails -> escalate to rebuild.

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { $, capture } from "../util/sh";
import { loadDotenv, mergeEnv, type EnvMap } from "../util/env";

interface CheckResult {
    ok: boolean;
    detail: string;
}

interface ReadinessCheck {
    slot: number;
    label: string;
    structural: boolean;
    run(rc: { env: EnvMap; cwd: string }): Promise<CheckResult>;
}

const isTty = process.stdout.isTTY === true;
const PASS_GLYPH = isTty ? "\x1b[32mOK\x1b[0m" : "OK";
const FAIL_GLYPH = isTty ? "\x1b[31mNG\x1b[0m" : "NG";

const CHECKS: ReadinessCheck[] = [
    {
        slot: 1, label: "DNS", structural: true,
        async run({ env }) {
            const domain = env["DOMAIN"];
            if (!domain) return { ok: false, detail: "DOMAIN not set in .env" };
            const dig = await capture($`dig +short A ${domain}`);
            const resolved = dig.ok ? (dig.stdout.trim().split("\n")[0]?.trim() ?? "") : "";
            const ip = (await capture($`curl -s4 --max-time 4 https://ifconfig.co`)).stdout.trim();
            return resolved !== "" && resolved === ip
                ? { ok: true, detail: `A(${domain})=${resolved} matches host IP ${ip}` }
                : { ok: false, detail: `A(${domain})='${resolved}' does not match host IP '${ip}'` };
        },
    },
    {
        slot: 2, label: "Ports", structural: true,
        async run() {
            const r = await capture($`bash -c "ss -ltnu 2>/dev/null | awk '{print $5}'"`);
            const has = (re: RegExp): boolean => re.test(r.stdout);
            const p80 = has(/:80(\s|$)/m);
            const p443 = has(/:443(\s|$)/m);
            return p80 && p443
                ? { ok: true, detail: "Ports 80/tcp + 443/tcp listening" }
                : { ok: false, detail: `Ports not listening (80=${p80 ? "ok" : "ng"}, 443=${p443 ? "ok" : "ng"})` };
        },
    },
    {
        slot: 3, label: "ACME", structural: true,
        async run({ env }) {
            const domain = env["DOMAIN"];
            if (!domain) return { ok: false, detail: "ACME — DOMAIN not set" };
            const r = await capture(
                $`bash -c "echo | timeout 6 openssl s_client -servername ${domain} -connect ${domain}:443 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null"`,
            );
            const issuer = r.stdout.trim();
            return /Let's Encrypt|STAGING/i.test(issuer)
                ? { ok: true, detail: `ACME cert issued by ${issuer.replace(/^issuer=/, "")}` }
                : { ok: false, detail: `ACME cert not from Let's Encrypt: '${issuer}'` };
        },
    },
    {
        slot: 4, label: "UFW", structural: true,
        async run() {
            if (!(await capture($`command -v ufw`)).ok) return { ok: false, detail: "UFW not installed" };
            const s = (await capture($`ufw status`)).stdout;
            const active = /^Status:\s+active/m.test(s);
            const has443 = /443\/tcp/.test(s);
            return active && has443
                ? { ok: true, detail: "UFW active with 443/tcp allowed" }
                : { ok: false, detail: "UFW rules incomplete or inactive" };
        },
    },
    {
        slot: 5, label: "Kernel", structural: false,
        async run() {
            const cc = (await capture($`sysctl -n net.ipv4.tcp_congestion_control`)).stdout.trim();
            const rmem = Number((await capture($`sysctl -n net.core.rmem_max`)).stdout.trim() || 0);
            return cc === "bbr" && rmem >= 7500000
                ? { ok: true, detail: `BBR active, rmem_max=${rmem}` }
                : { ok: false, detail: `Kernel not tuned (cc=${cc || "?"}, rmem_max=${rmem || "?"})` };
        },
    },
    {
        slot: 6, label: "NTP", structural: false,
        async run() {
            const r = await capture($`timedatectl`);
            return /System clock synchronized:\s+yes/i.test(r.stdout)
                ? { ok: true, detail: "Clock synchronised" }
                : { ok: false, detail: "Clock not synchronised — TLS will misbehave" };
        },
    },
    {
        slot: 7, label: "Components", structural: false,
        async run() {
            const r = await capture(
                $`bash -c "docker compose exec -T panel ct-server-core component check --manifests /srv/manifests 2>&1 || true"`,
            );
            if (!r.stdout.trim()) return { ok: false, detail: "could not run component check" };
            return /^\s*NG\s/m.test(r.stdout)
                ? { ok: false, detail: "Some components NG" }
                : { ok: true, detail: "All components OK" };
        },
    },
    {
        slot: 8, label: "Redis bridge", structural: false,
        async run({ env }) {
            const pw = env["REDIS_PASSWORD"];
            if (!pw) return { ok: false, detail: "REDIS_PASSWORD unset" };
            const publish = await capture(
                $`bash -c "docker compose exec -T -e REDISCLI_AUTH=${pw} panel sh -c 'redis-cli -h redis --no-auth-warning publish cool_tunnel:revocations \"{\\\"kind\\\":\\\"resync\\\"}\" >/dev/null'"`,
            );
            if (!publish.ok) return { ok: false, detail: "Could not publish to Redis" };
            await new Promise((r) => setTimeout(r, 3000));
            const logs = await capture(
                $`bash -c "docker compose logs --since=5s panel 2>/dev/null"`,
            );
            return /sing-?box reload(ed)?|caddy reloaded|revocation received/i.test(logs.stdout)
                ? { ok: true, detail: "Redis bridge alive (daemon ack'd a resync)" }
                : { ok: false, detail: "Published, but no daemon ack within 3s window" };
        },
    },
    {
        slot: 9, label: "Cover invariant", structural: false,
        async run({ env }) {
            const haveCurl = await capture(
                $`bash -c "docker compose exec -T panel sh -c 'command -v curl' >/dev/null 2>&1"`,
            );
            if (!haveCurl.ok) return { ok: false, detail: "curl missing in panel container" };
            const headOnly = (path: string) =>
                $`bash -c "docker compose exec -T panel sh -c \"curl -sI -m 5 http://127.0.0.1:9000${path} | grep -i '^etag:' | tr -d '\\r\\n' | sed -E 's/^.*etag:\\s*//i'\""`;
            const statusOnly = (path: string) =>
                $`bash -c "docker compose exec -T panel sh -c \"curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:9000${path}\""`;
            const etagSub = (await capture(headOnly("/api/v1/subscription/lnc-bogus"))).stdout.trim();
            const etagRand = (await capture(headOnly("/lnc-cover-probe"))).stdout.trim();
            const stSub = (await capture(statusOnly("/api/v1/subscription/lnc-bogus"))).stdout.trim();
            const stRand = (await capture(statusOnly("/lnc-cover-probe"))).stdout.trim();
            const domain = env["DOMAIN"];
            let serverHdr = "";
            if (domain) {
                const r = await capture(
                    $`bash -c "curl -sI -m 5 http://${domain}/ 2>/dev/null | grep -i '^server:' || true"`,
                );
                serverHdr = r.stdout.trim();
            }
            const etagMatch = etagSub !== "" && etagSub === etagRand;
            if (stSub === "200" && stRand === "200" && etagMatch && serverHdr === "") {
                return { ok: true, detail: "Cover-site invariant holds (200/200, ETags match, no Server header)" };
            }
            return {
                ok: false,
                detail: `Cover distinguisher: sub=${stSub} rand=${stRand} etag_match=${etagMatch ? "y" : "n"} server='${serverHdr || "<none>"}'`,
            };
        },
    },
    {
        slot: 10, label: "Anti-tracking probe", structural: false,
        async run({ env }) {
            const url = env["LNC_TEST_PROXY_URL"];
            if (!url) {
                return {
                    ok: false,
                    detail: `Set LNC_TEST_PROXY_URL=https://user:pass@${env["DOMAIN"] ?? "DOMAIN"}:443 to enable`,
                };
            }
            const r = await capture(
                $`bash -c "docker compose exec -T panel ct-server-core probe anti-tracking --via ${url} 2>/dev/null"`,
            );
            const ok = /"hide_ip_effective":true/.test(r.stdout) && /"hide_via_effective":true/.test(r.stdout);
            if (ok) return { ok: true, detail: "hide_ip + hide_via effective" };
            // Defense-in-depth: scrub any leaked creds before logging.
            const safe = r.stdout.replace(/([a-zA-Z+]+:\/\/)[^/@\s"]+:[^/@\s"]+@/g, "$1***:***@");
            return { ok: false, detail: `Anti-tracking probe failed: ${safe.slice(0, 300)}` };
        },
    },
];

async function readLine(): Promise<string> {
    return new Promise((resolve) => {
        process.stdin.once("data", (b) => resolve(b.toString()));
    });
}

async function tacticalRetreat(ctx: RunContext): Promise<boolean> {
    ctx.logger.info("[retreat] fetching tags…");
    const fetch = await capture($`git -C ${ctx.cwd} fetch --tags`);
    if (!fetch.ok) {
        ctx.logger.error(`git fetch failed: ${fetch.stderr.slice(0, 200)}`);
        return false;
    }
    const tags = await capture($`git -C ${ctx.cwd} tag --sort=-v:refname`);
    const lastTag = tags.stdout.trim().split("\n")[0];
    if (!lastTag) {
        ctx.logger.error("no git tags found; cannot retreat");
        return false;
    }
    ctx.logger.info(`[retreat] last good tag: ${lastTag}; checking out…`);
    const co = await capture($`git -C ${ctx.cwd} checkout ${lastTag}`);
    if (!co.ok) {
        ctx.logger.error(`git checkout failed: ${co.stderr.slice(0, 200)}`);
        return false;
    }
    ctx.logger.info(`[retreat] checked out ${lastTag}; restarting compose…`);
    const up = await capture($`docker compose up -d`);
    if (!up.ok) {
        ctx.logger.error(`compose up failed: ${up.stderr.slice(0, 200)}`);
        return false;
    }
    ctx.logger.info("[retreat] done. Re-run 'ct-operator readiness' to confirm.");
    return true;
}

async function cleanRebuild(ctx: RunContext): Promise<boolean> {
    ctx.logger.info("[rebuild] compose down…");
    await capture($`docker compose down`);
    ctx.logger.info("[rebuild] build --no-cache…");
    const b = await capture($`docker compose build --no-cache`);
    if (!b.ok) {
        ctx.logger.error(`build failed: ${b.stderr.slice(-500)}`);
        return false;
    }
    ctx.logger.info("[rebuild] compose up -d…");
    const up = await capture($`docker compose up -d`);
    if (!up.ok) {
        ctx.logger.error(`compose up failed: ${up.stderr.slice(0, 200)}`);
        return false;
    }
    ctx.logger.info("[rebuild] done. Re-run 'ct-operator readiness' to confirm.");
    return true;
}

async function offerRecovery(ctx: RunContext): Promise<void> {
    process.stdout.write(`\nRecovery options:\n`);
    process.stdout.write(`  [r] tactical retreat — git checkout <last-good-tag> + compose up -d\n`);
    process.stdout.write(`  [b] clean rebuild    — compose down + build --no-cache + up -d\n`);
    process.stdout.write(`  [s] skip             — leave the system alone\n`);
    process.stdout.write(`Choice [r/b/s] (default: skip): `);
    const reply = (await readLine()).trim().toLowerCase();
    if (reply === "r") {
        const ok = await tacticalRetreat(ctx);
        if (!ok) {
            ctx.logger.warn("retreat failed; escalating to clean rebuild");
            await cleanRebuild(ctx);
        }
    } else if (reply === "b") {
        await cleanRebuild(ctx);
    }
}

export class ReadinessTask implements Task {
    readonly name = "readiness";

    async run(ctx: RunContext): Promise<TaskResult> {
        const dotenv = await loadDotenv([`${ctx.cwd}/.env`, `${ctx.cwd}/../.env`]);
        const env = mergeEnv(ctx.env, dotenv?.env ?? null);

        process.stdout.write(`Late-Night Comeback — readiness check\n`);
        process.stdout.write(`(Domain: ${env["DOMAIN"] ?? "<unset>"})\n\n`);

        const results: Array<{ slot: number; label: string; ok: boolean; detail: string; structural: boolean }> = [];
        let structuralFails = 0;
        let pass = 0;

        const groups = [
            { name: "Structural (must pass)", slots: [1, 2, 3, 4] },
            { name: "Operational", slots: [5, 6, 7, 8] },
            { name: "Functional", slots: [9, 10] },
        ];

        for (const g of groups) {
            process.stdout.write(`${g.name}:\n`);
            for (const slot of g.slots) {
                const ch = CHECKS.find((c) => c.slot === slot)!;
                let r: CheckResult;
                try {
                    r = await ch.run({ env, cwd: ctx.cwd });
                } catch (err) {
                    r = { ok: false, detail: `check threw: ${err instanceof Error ? err.message : String(err)}` };
                }
                const glyph = r.ok ? PASS_GLYPH : FAIL_GLYPH;
                process.stdout.write(`  [${glyph}] ${ch.slot}. ${ch.label} — ${r.detail}\n`);
                if (r.ok) pass++;
                else if (ch.structural) structuralFails++;
                results.push({ slot: ch.slot, label: ch.label, ok: r.ok, detail: r.detail, structural: ch.structural });
            }
            process.stdout.write("\n");
        }

        let score = pass;
        if (structuralFails > 0 && score > 7) score = 7;
        const pct = Math.floor((score * 100) / 10);
        process.stdout.write(`Score: ${score}/10 (${pct}%)\n`);
        if (structuralFails > 0) {
            process.stdout.write(`Structural fail(s): ${structuralFails} — score capped at 7.\n`);
        }

        if (score >= 9) {
            process.stdout.write(`Result: PASS — ready to ship.\n`);
            return { ok: true, code: 0, summary: `${score}/10`, json: { score, results } };
        }

        process.stdout.write(`Result: FAIL — fix flagged checks before launch.\n`);
        if (ctx.interactive) await offerRecovery(ctx);

        return { ok: false, code: 1, summary: `${score}/10`, json: { score, results } };
    }
}
