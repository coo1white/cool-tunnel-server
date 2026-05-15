// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/fix.ts — interactive recipe walker.
//
// The 17 recipes from scripts/fix.sh are exposed as a typed registry.
// Each recipe is either:
//   - pure-TS, implemented in operator/src/tasks/recipes/<slug>.ts and
//     registered in PURE_TS_RECIPES below, OR
//   - delegating, falling back to the corresponding helper function in
//     scripts/fix.sh via a `bash -c` subshell with on-the-fly sed
//     extraction of everything before the canonical MAIN-section
//     divider.
//
// Recipes can be migrated from delegating to pure TS incrementally
// without changing this orchestration. The pure-TS path is preferred
// because it doesn't depend on fix.sh's MAIN-divider convention
// staying stable across releases.

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { $, capture } from "../util/sh";
import type { Recipe } from "./recipes/types";
import { recipe as dockerDaemonDown } from "./recipes/docker_daemon_down";
import { recipe as composeServiceDown } from "./recipes/compose_service_down";
import { recipe as pendingMigrations } from "./recipes/pending_migrations";
// v0.1.10 — four new pure-TS recipes for issues lit up by a real
// v0.1.7 first-deploy session. No corresponding scripts/fix.sh
// helpers; these slugs exist only here.
import { recipe as singBoxDohCrash } from "./recipes/sing_box_doh_crash";
import { recipe as composeCaddyZombie } from "./recipes/compose_caddy_zombie";
import { recipe as ipv6BrokenRouting } from "./recipes/ipv6_broken_routing";
import { recipe as staleSubscriptionUsers } from "./recipes/stale_subscription_users";
// v0.1.13 — five more pure-TS ports of clean docker / compose plumbing
// recipes from scripts/fix.sh (3, 4, 5, 7, 8). The riskier recipes
// (sysctl heredoc writes, artisan tinker DB edits, sing-box config
// rewrites) still delegate to fix.sh until they can be ported with
// confidence.
import { recipe as zombieDockerProxy } from "./recipes/zombie_docker_proxy";
import { recipe as foreignContainerPorts } from "./recipes/foreign_container_ports";
import { recipe as brokenContainerDns } from "./recipes/broken_container_dns";
import { recipe as haproxyBackendDns } from "./recipes/haproxy_backend_dns";
import { recipe as missingTlsCert } from "./recipes/missing_tls_cert";

// Slugs implemented in operator/src/tasks/recipes/*.ts. Everything else
// falls back to the delegating bash path below.
const PURE_TS_RECIPES = new Map<string, Recipe>([
    [dockerDaemonDown.slug, dockerDaemonDown],
    [composeServiceDown.slug, composeServiceDown],
    [pendingMigrations.slug, pendingMigrations],
    [singBoxDohCrash.slug, singBoxDohCrash],
    [composeCaddyZombie.slug, composeCaddyZombie],
    [ipv6BrokenRouting.slug, ipv6BrokenRouting],
    [staleSubscriptionUsers.slug, staleSubscriptionUsers],
    [zombieDockerProxy.slug, zombieDockerProxy],
    [foreignContainerPorts.slug, foreignContainerPorts],
    [brokenContainerDns.slug, brokenContainerDns],
    [haproxyBackendDns.slug, haproxyBackendDns],
    [missingTlsCert.slug, missingTlsCert],
]);

const RECIPE_SLUGS = [
    // Pure-TS recipes (v0.1.10) for the issues from the real-VPS
    // first-deploy debug session. These run BEFORE the legacy
    // delegating recipes so they catch the deployment-killer cases
    // first.
    "ipv6_broken_routing",
    "compose_caddy_zombie",
    "sing_box_doh_crash",
    "stale_subscription_users",
    // Legacy delegating recipes (mirror scripts/fix.sh's order).
    "docker_daemon_down",
    "compose_service_down",
    "zombie_docker_proxy",
    "foreign_container_ports",
    "broken_container_dns",
    "ipv6_dns_unreachable",
    "haproxy_backend_dns",
    "missing_tls_cert",
    "singbox_domain_resolver",
    "singbox_outbound_ipv4_only",
    "panel_restart_loop",
    "pending_migrations",
    "messenger_queue_stuck",
    "credential_drift",
    "no_proxy_account",
    "legacy_env_shape",
    "stale_deployment",
] as const;

async function findFixSh(cwd: string): Promise<{ repoRoot: string; fixSh: string } | null> {
    for (const root of [cwd, `${cwd}/..`]) {
        const p = `${root}/scripts/fix.sh`;
        if (await Bun.file(p).exists()) return { repoRoot: root, fixSh: p };
    }
    return null;
}

function shQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}

function runHelper(repoRoot: string, expr: string): ReturnType<typeof $> {
    // Strip fix.sh's MAIN section (delimited by the canonical `=====`
    // separator) before sourcing, so we get only the function defs.
    const script = `
set -uo pipefail
cd ${shQuote(repoRoot)}
export CT_NO_FIX_HINT=1
eval "$(sed '/^# ============================================================$/,$d' scripts/fix.sh)"
${expr}
`;
    return $`bash -c ${script}`;
}

function makeRecipe(slug: string): Recipe {
    return {
        slug,
        async describe() {
            return `see scripts/fix.sh::describe_${slug}`;
        },
        async detect(ctx) {
            const r = await findFixSh(ctx.cwd);
            if (!r) return false;
            const out = await capture(runHelper(r.repoRoot, `detect_${slug}`));
            return out.ok;
        },
        async fix(ctx) {
            const r = await findFixSh(ctx.cwd);
            if (!r) return { ok: false, detail: "scripts/fix.sh not found" };
            const out = await capture(runHelper(r.repoRoot, `fix_${slug}`));
            return out.ok
                ? { ok: true }
                : { ok: false, detail: (out.stderr.split("\n")[0] ?? `exit ${out.code}`).slice(0, 300) };
        },
        async verify(ctx) {
            const r = await findFixSh(ctx.cwd);
            if (!r) return false;
            const out = await capture(runHelper(r.repoRoot, `! detect_${slug}`));
            return out.ok;
        },
    };
}

const RECIPES: Recipe[] = RECIPE_SLUGS.map(
    (slug) => PURE_TS_RECIPES.get(slug) ?? makeRecipe(slug),
);

interface Counters {
    ok: number;
    detected: number;
    fixed: number;
    skipped: number;
    failed: number;
}

async function readLine(): Promise<string> {
    return new Promise((resolve) => {
        process.stdin.once("data", (b) => resolve(b.toString()));
    });
}

async function promptAction(
    slug: string,
    interactive: boolean,
    autoApply: boolean,
): Promise<"apply" | "skip" | "explain" | "quit"> {
    // v0.1.10 --auto mode: skip the prompt entirely, apply every
    // detected fix. For cron, for tired operators, for unattended
    // recovery. Honours --no-bridge too via ctx upstream.
    if (autoApply) {
        process.stderr.write(`  ${slug} -- [auto] applying\n`);
        return "apply";
    }
    if (!interactive) {
        process.stderr.write(`  ${slug} -- (non-tty, defaulting to skip; pass --auto to apply)\n`);
        return "skip";
    }
    for (;;) {
        process.stderr.write(`  ${slug} -- [a]pply / [s]kip / [e]xplain / [q]uit: `);
        const reply = (await readLine()).trim().toLowerCase();
        if (reply === "a" || reply === "apply") return "apply";
        if (reply === "s" || reply === "skip" || reply === "") return "skip";
        if (reply === "e" || reply === "explain") return "explain";
        if (reply === "q" || reply === "quit") return "quit";
        process.stderr.write(`    please answer a / s / e / q\n`);
    }
}

export class FixTask implements Task {
    readonly name = "fix";

    async run(ctx: RunContext): Promise<TaskResult> {
        const found = await findFixSh(ctx.cwd);
        if (!found) {
            ctx.logger.error("scripts/fix.sh not found in cwd or parent");
            return { ok: false, code: 2, summary: "no fix.sh" };
        }
        // v0.1.10: --auto applies every detected fix without prompting.
        // Read from process.argv directly since the runner doesn't pass
        // task-specific args through ctx; clean separation between
        // global flags (--json, --no-bridge) and task flags (--auto).
        const autoApply = process.argv.includes("--auto");
        const hn = (await capture($`hostname`)).stdout.trim() || "?";
        process.stdout.write(`Cool Tunnel Server -- fix agent${autoApply ? " (--auto)" : ""}\n`);
        process.stdout.write(`  host=${hn}, ${new Date().toISOString()}\n`);
        process.stdout.write(`  via ${found.fixSh}\n\n`);
        process.stdout.write(
            `Walking ${RECIPES.length} recipes. ` +
                (autoApply
                    ? "Auto-apply mode: every detected issue is fixed without prompting.\n\n"
                    : "For each detected issue: apply / skip / explain / quit.\n\n"),
        );

        const counts: Counters = { ok: 0, detected: 0, fixed: 0, skipped: 0, failed: 0 };

        outer: for (const recipe of RECIPES) {
            const detected = await recipe.detect(ctx);
            if (!detected) {
                counts.ok++;
                process.stdout.write(`  [ok]   ${recipe.slug}\n`);
                continue;
            }
            counts.detected++;
            process.stdout.write(`  [!]    ${recipe.slug} detected\n`);

            for (;;) {
                const action = await promptAction(recipe.slug, ctx.interactive, autoApply);
                if (action === "explain") {
                    process.stdout.write(`    ${await recipe.describe(ctx)}\n`);
                    continue;
                }
                if (action === "skip") {
                    counts.skipped++;
                    break;
                }
                if (action === "quit") break outer;
                // apply
                const r = await recipe.fix(ctx);
                if (!r.ok) {
                    counts.failed++;
                    process.stdout.write(`  [fail] ${recipe.slug}: ${r.detail ?? "unknown"}\n`);
                    break;
                }
                const verified = await recipe.verify(ctx);
                if (verified) {
                    counts.fixed++;
                    process.stdout.write(`  [fix]  ${recipe.slug}\n`);
                } else {
                    counts.failed++;
                    process.stdout.write(`  [fail] ${recipe.slug}: fix did not clear detect\n`);
                }
                break;
            }
        }

        process.stdout.write(`\nSummary:\n`);
        process.stdout.write(`  ${counts.ok} recipes OK on first check\n`);
        process.stdout.write(
            `  ${counts.detected} issues detected, ${counts.fixed} fixed, ${counts.skipped} skipped, ${counts.failed} failed\n`,
        );

        const ok = counts.failed === 0;
        return {
            ok,
            code: ok ? 0 : 1,
            summary: `${counts.detected}D/${counts.fixed}F/${counts.failed}E`,
            json: counts,
        };
    }
}
