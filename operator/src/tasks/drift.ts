// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/drift.ts — ct-operator drift task.
//
// Runs the three-way drift check (DB ⇄ rendered singbox.json ⇄
// subscription endpoint). Surfaces drifts that the strict component
// check / credential-lock guard misses because those only compare
// lock-hashes, not values clients actually authenticate with.
//
// v0.4.0+: the proxy server is ct-singbox (SagerNet/sing-box in
// VLESS+Reality server mode); the credentials it accepts come from
// /data/config/singbox.json which the panel renders via
// SingboxConfigGenerator (which shells to `singbox-core
// render-server`). The credential type is a VLESS UUID per
// ProxyAccount.
//
// Architecture history:
//   pre-v0.2.x: drift checked DB ⇄ sing-box config ⇄ subscription
//   v0.2.x:     DB ⇄ Caddyfile basic_auth ⇄ subscription
//   v0.3.x:     DB ⇄ naive.json ⇄ subscription
//   v0.4.x:     DB ⇄ singbox.json ⇄ subscription (UUID-typed)
//
// Exit codes (cron / CI suitable):
//   0   every account's three layers agree
//   1   one or more rows have drift
//   2   prerequisite missing (docker not on PATH, panel down, etc.)

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import { $, capture, which } from "../util/sh";
import {
    type DriftRow,
    type DriftReport,
    buildReport,
    parseSingboxJsonUsers,
    parseSubscriptionResponse,
    renderTable,
} from "../util/drift-check";

// Compose-exec the tinker one-liner that emits one JSON row per
// ProxyAccount: `{id, username, uuid}`. v0.4.0 schema: the
// credential is now a VLESS UUID rather than an encrypted
// password; stored in plain text since UUIDs aren't secrets
// individually (they're the credential — like an API key — and
// only the user-account row holding them needs the same disk
// protection as the rest of the DB).
//
// One PHP process, one JSON stream out — avoids N*~300ms compose-
// exec overhead per account.
const TINKER_DUMP = String.raw`
$rows = \App\Models\ProxyAccount::query()->orderBy('id')->get();
foreach ($rows as $a) {
    echo json_encode([
        'id' => $a->id,
        'username' => $a->username,
        'uuid' => (string) ($a->uuid ?? ''),
        'subscription_token' => $a->subscriptionToken(),
        'active' => $a->isActive(),
    ]) . "\n";
}
`;

interface DbRow {
    readonly id: number;
    readonly username: string;
    readonly uuid: string;
    readonly subscriptionToken: string;
    readonly active: boolean;
}

async function dumpDbRows(): Promise<DbRow[]> {
    const r = await capture(
        $`docker compose exec -T panel php artisan tinker --execute=${TINKER_DUMP}`,
    );
    if (!r.ok) {
        const tail = (r.stderr || r.stdout).split("\n").slice(-3).join(" | ").slice(0, 240);
        throw new Error(`tinker dump failed (exit ${r.code}): ${tail}`);
    }
    const out: DbRow[] = [];
    for (const line of r.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
            const obj = JSON.parse(trimmed) as {
                id: number;
                username: string;
                uuid: string;
                subscription_token: string;
                active: boolean;
            };
            out.push({
                id: obj.id,
                username: obj.username,
                uuid: obj.uuid,
                subscriptionToken: obj.subscription_token,
                active: obj.active,
            });
        } catch {
            continue;
        }
    }
    return out;
}

/**
 * Read the rendered singbox.json off the panel container — the same
 * /data/config/singbox.json mount ct-singbox reads. Returns null if
 * the file isn't there (render hasn't run yet, or pre-v0.4.0 stack
 * mounting at /data/config/naive.json).
 *
 * We read via the panel container (not ct-singbox) because the panel
 * is the writer with RW on singbox_config; it's always running.
 */
async function dumpSingboxJson(): Promise<string | null> {
    const r = await capture($`docker compose exec -T panel cat /data/config/singbox.json`);
    if (!r.ok) return null;
    return r.stdout;
}

async function fetchSubscription(panelDomain: string, token: string): Promise<string | null> {
    if (token === "") return null;
    const url = `https://${panelDomain}/api/v1/subscription/${token}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        return await res.text();
    } catch {
        return null;
    }
}

/** Same panel-domain resolution as core/ct-server-core/src/util/domain.rs. */
function resolvePanelDomain(env: NodeJS.ProcessEnv): string {
    const explicit = (env["PANEL_DOMAIN"] ?? "").trim();
    if (explicit !== "") return explicit;
    const apex = (env["DOMAIN"] ?? "").trim();
    if (apex !== "") return `panel.${apex}`;
    return "";
}

async function collectRows(panelDomain: string): Promise<DriftRow[]> {
    const dbRows = await dumpDbRows();
    const singboxRaw = await dumpSingboxJson();
    const singboxUsers = singboxRaw === null ? [] : parseSingboxJsonUsers(singboxRaw);
    const singboxByUsername = new Map<string, string>();
    for (const u of singboxUsers) {
        singboxByUsername.set(u.username, u.uuid);
    }

    // Subscription fetch parallelised at 8-deep so a panel with
    // tens of accounts doesn't get hammered by self-traffic.
    const PARALLELISM = 8;
    const subResults = new Map<number, string | null>();
    for (let i = 0; i < dbRows.length; i += PARALLELISM) {
        const batch = dbRows.slice(i, i + PARALLELISM);
        const results = await Promise.all(
            batch.map(async (r) => ({
                id: r.id,
                body: await fetchSubscription(panelDomain, r.subscriptionToken),
            })),
        );
        for (const { id, body } of results) {
            subResults.set(id, body);
        }
    }

    const rows: DriftRow[] = [];
    for (const dbRow of dbRows) {
        const subBody = subResults.get(dbRow.id) ?? null;
        const subParsed = subBody === null ? null : parseSubscriptionResponse(subBody);
        const subForRow =
            subParsed === null
                ? null
                : (subParsed.profiles.find((p) => p.username === dbRow.username)?.uuid ?? null);
        const singboxForRow = singboxByUsername.has(dbRow.username)
            ? singboxByUsername.get(dbRow.username)!
            : null;
        rows.push({
            accountId: dbRow.id,
            username: dbRow.username,
            db: dbRow.uuid || null,
            singbox: singboxForRow,
            subscription: subForRow,
        });
    }

    // Phantom singbox users: a user/uuid in singbox.json with no DB
    // row. Typically a deleted account whose singbox.json wasn't
    // re-rendered. Surface as rows with db=null.
    const dbUsernames = new Set(dbRows.map((r) => r.username));
    for (const u of singboxUsers) {
        if (!dbUsernames.has(u.username)) {
            rows.push({
                accountId: -1,
                username: u.username,
                db: null,
                singbox: u.uuid,
                subscription: null,
            });
        }
    }

    return rows;
}

export class DriftTask implements Task {
    readonly name = "drift";

    async run(ctx: RunContext): Promise<TaskResult> {
        if (!(await which("docker"))) {
            return { ok: false, code: 2, summary: "docker missing", skipBridge: true };
        }
        const panelDomain = resolvePanelDomain(ctx.env);
        if (panelDomain === "") {
            return {
                ok: false,
                code: 2,
                summary: "PANEL_DOMAIN / DOMAIN unset in .env",
                skipBridge: true,
            };
        }

        let report: DriftReport;
        try {
            const rows = await collectRows(panelDomain);
            report = buildReport(rows);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                ok: false,
                code: 2,
                summary: `drift collection failed: ${msg}`,
                skipBridge: true,
            };
        }

        if (!ctx.json) {
            process.stdout.write(renderTable(report) + "\n");
            const drifted = report.findings.filter((f) => f.severity === "fail").length;
            const warned = report.findings.filter((f) => f.severity === "warn").length;
            if (report.ok) {
                process.stdout.write(
                    `\nok: ${report.findings.length} accounts, all three layers aligned\n`,
                );
            } else {
                process.stdout.write(
                    `\nFAIL: ${drifted} drift, ${warned} warn across ${report.findings.length} accounts\n` +
                        `Repair: ./ct render singbox        # if singbox.json drifts from DB\n` +
                        `        Filament UI Regenerate-UUID # if DB uuid is stale\n`,
                );
            }
        }

        return {
            ok: report.ok,
            code: report.ok ? 0 : 1,
            summary: report.ok
                ? `${report.findings.length} accounts aligned`
                : `${report.findings.filter((f) => f.severity === "fail").length} drifted`,
            json: report,
            skipBridge: !report.ok,
        };
    }
}
