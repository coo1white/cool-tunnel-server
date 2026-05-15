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

// In production ctx.cwd is the repo root (./ct ballast). In dev
// (`bun run src/index.ts ballast` from operator/) ctx.cwd is the
// operator dir. tryPaths() returns the first candidate that exists,
// so checks that look at scripts/ or core/ work either way.
async function tryPaths(...candidates: string[]): Promise<string | null> {
    for (const p of candidates) {
        if (await Bun.file(p).exists()) return p;
    }
    return null;
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
            // Port 9000 matches scripts/doctor.sh::check_up_endpoint —
            // FrankenPHP's host-side bind is 127.0.0.1:9000, not 8000
            // (the v0.1.4 default was wrong).
            const port = ctx.env["PANEL_OCTANE_PORT"] ?? "9000";
            const r = await capture($`curl -fsS --max-time 3 http://127.0.0.1:${port}/up`);
            return r.ok
                ? { status: "pass" }
                : { status: "fail", detail: `http://127.0.0.1:${port}/up unreachable` };
        },
    },
    {
        slug: "redis-ping",
        title: "Redis reachable",
        async run(ctx) {
            const pw = ctx.env["REDIS_PASSWORD"];
            // REDISCLI_AUTH (env, not -a on argv) keeps the secret off
            // `ps -ef`. Matches scripts/late-night-comeback.sh's pattern.
            if (await which("redis-cli")) {
                const r = pw
                    ? await capture($`redis-cli --no-auth-warning ping`.env({ ...process.env, REDISCLI_AUTH: pw }))
                    : await capture($`redis-cli ping`);
                if (r.ok && r.stdout.trim() === "PONG") return { status: "pass" };
            }
            if (await which("docker")) {
                const r = pw
                    ? await capture($`docker compose exec -T -e REDISCLI_AUTH=${pw} redis redis-cli --no-auth-warning ping`)
                    : await capture($`docker compose exec -T redis redis-cli ping`);
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
            if (!(await which("cargo"))) return { status: "warn", detail: "cargo not on PATH (dev-only check)" };
            const cargoToml = await tryPaths(
                `${ctx.cwd}/core/Cargo.toml`,
                `${ctx.cwd}/../core/Cargo.toml`,
            );
            if (!cargoToml) return { status: "warn", detail: "core/Cargo.toml not found" };
            const coreDir = cargoToml.replace(/\/Cargo\.toml$/, "");
            const r = await capture($`bash -c "cd ${coreDir} && cargo sqlx prepare --check 2>&1"`);
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
            // Caddy nests certs under the ACME issuer subdirectory:
            //   /data/caddy/certificates/<issuer>/<domain>/<domain>.crt
            // v0.1.6 listed only the top level and grepped for the
            // domain — the listing was the issuer dir, never the
            // domain, so the check always FAILed on a real deploy.
            //
            // v0.1.12 unnested the shell layering. Pre-this-fix the
            // expiry probe ran `bash -c "docker compose exec sh -c
            // \"openssl ... -checkend $((7*86400))\""`. Bun's $
            // template literal parser saw `$((` and tried to read
            // it as command substitution (`$(...)`), failing with
            // `expected a command or assignment but got:
            // "CmdSubstEnd"`. The whole check threw before either
            // sub-shell ran. Pre-computing the seconds in TS and
            // dropping the redundant `bash -c "..."` wrapper makes
            // the call a single argv that Bun escapes correctly.
            const certName = `${domain}.crt`;
            const find = await capture(
                $`docker compose exec -T caddy find /data/caddy/certificates -name ${certName} -print -quit`,
            );
            const certPath = find.stdout.trim();
            if (!find.ok || !certPath) {
                return { status: "fail", detail: `no ${certName} found under caddy_data` };
            }
            const sevenDaysInSeconds = 7 * 86400;
            const probe = await capture(
                $`docker compose exec -T caddy openssl x509 -in ${certPath} -noout -checkend ${sevenDaysInSeconds}`,
            );
            return probe.ok
                ? { status: "pass" }
                : { status: "warn", detail: `cert expires within 7 days or expiry probe failed (${certPath})` };
        },
    },
    {
        slug: "singbox-admin",
        title: "sing-box container running",
        async run() {
            // v0.1.6 probed the host on port 9090, but the clash admin
            // port is bound INSIDE the sing-box container only (project
            // security policy — never expose the admin port to the host).
            // From the host the check could never succeed even on a
            // healthy deploy. Switch to a container-state assertion —
            // mirrors panel-container, uses the same compose primitive.
            if (!(await which("docker"))) return { status: "warn", detail: "docker not on PATH" };
            const r = await capture($`docker compose ps sing-box --status running --quiet`);
            if (!r.ok) return { status: "fail", detail: r.stderr.split("\n")[0] ?? "compose ps failed" };
            return r.stdout.trim() ? { status: "pass" } : { status: "fail", detail: "sing-box not running" };
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
        async run() {
            // Was shelling out to scripts/verify_sot.sh; that script
            // is now gone. The same fixture matrix + equivalence
            // logic lives in operator/src/util/sot.ts, and we call
            // the VPS runner in-process: the ballast check is meant
            // to assert the running deployment's PHP and Rust
            // implementations agree, which is exactly what
            // verify-sot-vps does. The dev-side host runner is for
            // `make ci` only.
            if (!(await which("docker"))) return { status: "warn", detail: "docker not on PATH" };
            const compose = await capture($`docker compose exec -T panel true`);
            if (!compose.ok) {
                return { status: "warn", detail: "panel container not reachable" };
            }
            const { runFixtures } = await import("../../util/sot");
            const { makeVpsRunner } = await import("../../util/sot-runners");
            const summary = await runFixtures(makeVpsRunner());
            return summary.failed === 0
                ? { status: "pass" }
                : { status: "fail", detail: `${summary.failed}/${summary.outcomes.length} fixtures disagreed` };
        },
    },
    {
        slug: "ct-operator-version",
        title: "ct-operator binary version matches panel config",
        async run(ctx) {
            // The deploy-skew failure mode that ate hours on the
            // 2026-05-15 v0.1.12 → v0.1.13 Vultr update: the
            // operator binary on disk was v0.1.12, but the wrapper
            // (post-git-pull) dispatched `update` — a subcommand
            // v0.1.12 didn't have. Result: "error: unknown
            // command: update". This check surfaces that mismatch
            // before the operator notices via a broken `./ct`
            // invocation.
            const phpPath = await tryPaths(
                `${ctx.cwd}/panel/config/cool-tunnel.php`,
                `${ctx.cwd}/../panel/config/cool-tunnel.php`,
            );
            if (!phpPath) {
                return { status: "warn", detail: "panel/config/cool-tunnel.php not found" };
            }
            const { parsePanelConfigVersion } = await import("../../util/version-bridge");
            const expected = parsePanelConfigVersion(await Bun.file(phpPath).text());
            if (expected === null) {
                return { status: "warn", detail: "no version field in panel/config/cool-tunnel.php" };
            }
            // The compiled binary knows its own version via BUILD_VERSION;
            // imported from the entry-point's constant indirectly through
            // the ENV-injected operator_version field. Dev runs (no
            // BUILD_VERSION) fall back to "dev" — warn rather than fail.
            const own = ctx.env["_CT_OPERATOR_OWN_VERSION"] ?? "dev";
            if (own === "dev") {
                return { status: "warn", detail: "running dev build; skipping skew check" };
            }
            return own === expected
                ? { status: "pass" }
                : {
                      status: "fail",
                      detail: `operator binary=${own}, panel/config=${expected} (run: ./ct update OR make operator-fetch)`,
                  };
        },
    },
    {
        slug: "ct-core-version",
        title: "ct-server-core version matches core/Cargo.toml",
        async run(ctx) {
            // The workspace root core/Cargo.toml holds the actual
            // `version = "X.Y.Z"`; ct-server-core/Cargo.toml uses
            // `version.workspace = true`. v0.1.4 read the wrong file
            // and reported "no version field" against a deployed VPS.
            const cargoPath = await tryPaths(
                `${ctx.cwd}/core/Cargo.toml`,
                `${ctx.cwd}/../core/Cargo.toml`,
            );
            if (!cargoPath) {
                return { status: "warn", detail: "core/Cargo.toml not found" };
            }
            const cargo = Bun.file(cargoPath);
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
