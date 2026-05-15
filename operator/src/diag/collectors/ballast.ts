// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/diag/collectors/ballast.ts — critical-invariant set.
// If any of these fail, the deployment is unsafe to keep running.
//
// Order matters: cheapest probes first so a clearly-broken stack
// fails fast instead of timing out on every layer.

import type { BallastCheckResult, BallastResult, CheckStatus } from "../types";
import type { RunContext } from "../../runner/context";
import { $, capture, which } from "../../util/sh";

interface CheckOutcome {
    status: CheckStatus;
    detail?: string;
}

interface Check {
    slug: string;
    title: string;
    run(ctx: RunContext): Promise<CheckOutcome>;
}

const CHECKS: Check[] = [
    {
        slug: "panel-container",
        title: "Panel container present",
        async run() {
            if (!(await which("docker"))) return { status: "warn", detail: "docker not on PATH" };
            const r = await capture($`docker compose ps panel --status running --quiet`);
            if (!r.ok) return { status: "fail", detail: r.stderr.split("\n")[0] ?? "compose ps failed" };
            return r.stdout.trim() ? { status: "pass" } : { status: "fail", detail: "panel not running" };
        },
    },
    {
        slug: "panel-octane-up",
        title: "Panel Octane responds on /up",
        async run(ctx) {
            const port = ctx.env["PANEL_OCTANE_PORT"] ?? "8000";
            const r = await capture($`curl -fsS --max-time 3 http://localhost:${port}/up`);
            return r.ok
                ? { status: "pass" }
                : { status: "fail", detail: `http://localhost:${port}/up unreachable` };
        },
    },
    {
        slug: "redis-ping",
        title: "Redis reachable",
        async run() {
            if (await which("redis-cli")) {
                const r = await capture($`redis-cli ping`);
                if (r.ok && r.stdout.trim() === "PONG") return { status: "pass" };
            }
            if (await which("docker")) {
                const r = await capture($`docker compose exec -T redis redis-cli ping`);
                if (r.ok && r.stdout.includes("PONG")) return { status: "pass" };
            }
            return { status: "fail", detail: "no PONG from any redis path" };
        },
    },
    {
        slug: "db-schema-version",
        title: "DB schema at expected migration",
        async run(ctx) {
            const expected = await readExpectedMigration(ctx);
            if (!expected) {
                return { status: "warn", detail: "operator/expected-migration.txt missing — skipping" };
            }
            if (!(await which("docker"))) return { status: "warn", detail: "docker not on PATH" };
            const r = await capture($`docker compose exec -T panel php artisan migrate:status`);
            if (!r.ok) return { status: "fail", detail: "migrate:status failed" };
            return r.stdout.includes(expected)
                ? { status: "pass" }
                : { status: "warn", detail: `expected migration "${expected}" not present in status output` };
        },
    },
    {
        slug: "sqlx-cache",
        title: "sqlx cache in sync with schema",
        async run(ctx) {
            if (!(await which("cargo"))) return { status: "warn", detail: "cargo not on PATH" };
            const r = await capture($`bash -c "cd ${ctx.cwd}/../core && cargo sqlx prepare --check 2>&1"`);
            return r.ok ? { status: "pass" } : { status: "fail", detail: "cargo sqlx prepare --check failed" };
        },
    },
    {
        slug: "caddy-acme",
        title: "Caddy ACME cert present + valid >=7d",
        async run(ctx) {
            const domain = ctx.env["PANEL_DOMAIN"];
            if (!domain) return { status: "warn", detail: "PANEL_DOMAIN not set" };
            if (!(await which("docker"))) return { status: "warn", detail: "docker not on PATH" };
            const ls = await capture(
                $`bash -c "docker compose exec -T caddy ls /data/caddy/certificates 2>/dev/null"`,
            );
            if (!ls.ok || !ls.stdout.includes(domain)) {
                return { status: "fail", detail: `no cert dir for ${domain} under caddy_data` };
            }
            const probe = await capture(
                $`bash -c "docker compose exec -T caddy sh -c 'openssl x509 -in /data/caddy/certificates/*/${domain}/${domain}.crt -noout -checkend $((7*86400))'"`,
            );
            return probe.ok
                ? { status: "pass" }
                : { status: "warn", detail: "cert expires within 7 days or expiry probe failed" };
        },
    },
    {
        slug: "singbox-admin",
        title: "sing-box admin port reachable",
        async run(ctx) {
            const port = ctx.env["SINGBOX_ADMIN_PORT"] ?? "9090";
            if (!(await which("nc"))) return { status: "warn", detail: "nc not on PATH" };
            const r = await capture($`nc -z -w 2 localhost ${port}`);
            return r.ok
                ? { status: "pass" }
                : { status: "fail", detail: `nc -z localhost ${port} failed` };
        },
    },
    {
        slug: "haproxy-stats",
        title: "HAProxy stats socket",
        async run() {
            const sock = "/var/run/haproxy.sock";
            if (!(await which("socat"))) return { status: "warn", detail: "socat not on PATH" };
            const r = await capture(
                $`bash -c "echo 'show info' | socat - UNIX-CONNECT:${sock} 2>&1 | head -5"`,
            );
            return r.ok && r.stdout.includes("Name:")
                ? { status: "pass" }
                : { status: "warn", detail: "stats socket unreachable" };
        },
    },
    {
        slug: "sot-parity",
        title: "Cross-language SoT parity (panel_domain)",
        async run(ctx) {
            const sot = `${ctx.cwd}/../scripts/verify_sot.sh`;
            if (!(await Bun.file(sot).exists())) {
                return { status: "warn", detail: "scripts/verify_sot.sh not found" };
            }
            const r = await capture($`bash ${sot}`);
            return r.ok ? { status: "pass" } : { status: "fail", detail: "verify_sot.sh disagreed" };
        },
    },
    {
        slug: "ct-core-version",
        title: "ct-server-core version matches core/ct-server-core/Cargo.toml",
        async run(ctx) {
            const cargo = Bun.file(`${ctx.cwd}/../core/ct-server-core/Cargo.toml`);
            if (!(await cargo.exists())) {
                return { status: "warn", detail: "core/ct-server-core/Cargo.toml not found" };
            }
            const m = (await cargo.text()).match(/^version\s*=\s*"([^"]+)"/m);
            if (!m || !m[1]) return { status: "warn", detail: "no version field in Cargo.toml" };
            const expected = m[1];
            if (!(await which("docker"))) return { status: "warn", detail: "docker not on PATH" };
            const r = await capture($`docker compose exec -T panel ct-server-core --version`);
            if (!r.ok) return { status: "fail", detail: "ct-server-core --version failed" };
            return r.stdout.includes(expected)
                ? { status: "pass" }
                : { status: "fail", detail: `binary version != ${expected}` };
        },
    },
];

async function readExpectedMigration(ctx: RunContext): Promise<string | null> {
    const f = Bun.file(`${ctx.cwd}/expected-migration.txt`);
    if (!(await f.exists())) return null;
    return (await f.text()).trim();
}

export async function collectBallast(ctx: RunContext): Promise<BallastResult> {
    const results: BallastCheckResult[] = [];
    for (const check of CHECKS) {
        try {
            const r = await check.run(ctx);
            const entry: BallastCheckResult = { slug: check.slug, title: check.title, status: r.status };
            if (r.detail !== undefined) entry.detail = r.detail;
            results.push(entry);
        } catch (err) {
            results.push({
                slug: check.slug,
                title: check.title,
                status: "fail",
                detail: `check threw: ${err instanceof Error ? err.message : String(err)}`,
            });
        }
    }
    const overall_ok = results.every((r) => r.status !== "fail");
    return { overall_ok, checks: results };
}

export { CHECKS as BALLAST_CHECKS };
