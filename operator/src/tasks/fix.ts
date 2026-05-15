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

// Slugs implemented in operator/src/tasks/recipes/*.ts. Everything else
// falls back to the delegating bash path below.
const PURE_TS_RECIPES = new Map<string, Recipe>([
    [dockerDaemonDown.slug, dockerDaemonDown],
    [composeServiceDown.slug, composeServiceDown],
    [pendingMigrations.slug, pendingMigrations],
]);

const RECIPE_SLUGS = [
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

async function promptAction(slug: string, interactive: boolean): Promise<"apply" | "skip" | "explain" | "quit"> {
    if (!interactive) {
        process.stderr.write(`  ${slug} -- (non-tty, defaulting to skip)\n`);
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
        const hn = (await capture($`hostname`)).stdout.trim() || "?";
        process.stdout.write(`Cool Tunnel Server -- fix agent\n`);
        process.stdout.write(`  host=${hn}, ${new Date().toISOString()}\n`);
        process.stdout.write(`  via ${found.fixSh}\n\n`);
        process.stdout.write(`Walking ${RECIPES.length} recipes. For each detected issue: apply / skip / explain / quit.\n\n`);

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
                const action = await promptAction(recipe.slug, ctx.interactive);
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
