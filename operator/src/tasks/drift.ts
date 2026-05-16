// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/drift.ts — ct-operator drift task.
//
// Runs the three-way cleartext drift check (DB ⇄ rendered
// naive.json ⇄ subscription endpoint). Surfaces drifts that the
// strict component check / credential-lock guard misses because
// those only compare lock-hashes, not values.
//
// v0.3.0+: the proxy server is ct-naive (klzgrad/naiveproxy run
// as server); the credentials it accepts come from
// /data/config/naive.json which the panel renders via
// `ct-server-core naive render`. Pre-v0.3.x the source of truth
// was the Caddyfile's basic_auth lines; pre-v0.2.x it was
// sing-box's user list.
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
    parseNaiveJsonAuth,
    parseSubscriptionResponse,
    renderTable,
} from "../util/drift-check";

// Compose-exec the tinker one-liner that emits one JSON row per
// ProxyAccount: `{id, username, cleartext}`. The cleartext column
// is decrypted via Laravel's Crypt facade (the same primitive the
// renderer + the subscription controller use).
//
// We deliberately do NOT call this for every account in N
// separate exec calls — that adds N*~300ms compose-exec overhead
// on a stack handling 50+ accounts. One PHP process, one JSON
// stream out.
const TINKER_DUMP = String.raw`
$rows = \App\Models\ProxyAccount::query()->orderBy('id')->get();
foreach ($rows as $a) {
    try {
        $cleartext = \Illuminate\Support\Facades\Crypt::decryptString($a->password_cleartext_encrypted ?? '');
    } catch (\Throwable $e) {
        $cleartext = null;
    }
    echo json_encode([
        'id' => $a->id,
        'username' => $a->username,
        'cleartext' => $cleartext,
        'subscription_token' => $a->subscriptionToken(),
        'active' => $a->isActive(),
    ]) . "\n";
}
`;

interface DbRow {
    readonly id: number;
    readonly username: string;
    readonly cleartext: string | null;
    readonly subscriptionToken: string;
    readonly active: boolean;
}

async function dumpDbRows(): Promise<DbRow[]> {
    // `tinker --execute=<snippet>` runs the snippet against the
    // panel's bootstrapped Laravel app. We pass the snippet through
    // Bun.$'s automatic argv-escaping (NOT inline interpolation)
    // so PHP namespace separators don't get mangled.
    const r = await capture($`docker compose exec -T panel php artisan tinker --execute=${TINKER_DUMP}`);
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
                cleartext: string | null;
                subscription_token: string;
                active: boolean;
            };
            out.push({
                id: obj.id,
                username: obj.username,
                cleartext: obj.cleartext,
                subscriptionToken: obj.subscription_token,
                active: obj.active,
            });
        } catch {
            // Tolerate stray non-JSON lines (Laravel boot output,
            // welcome banners, deprecation notices). They're
            // never JSON-object-shaped so they get filtered above
            // most of the time; this catch handles partial-line
            // edge cases.
            continue;
        }
    }
    return out;
}

// Read the rendered naive.json off the panel container — the
// same /data/config/naive.json mount ct-naive reads. Returns null
// if the file isn't there (render hasn't run yet, or pre-v0.3.0
// stack mounting at /etc/caddy/Caddyfile / /etc/sing-box/).
//
// We deliberately read it via the panel container (not the
// ct-naive container) because the panel is the one with RW on
// naive_config; it's always running and is the writer.
async function dumpNaiveJson(): Promise<string | null> {
    const r = await capture($`docker compose exec -T panel cat /data/config/naive.json`);
    if (!r.ok) return null;
    return r.stdout;
}

// Fetch the subscription endpoint for one token. The panel runs
// behind Caddy on :443; we hit it via the public HOSTNAME the
// operator's clients use (so the network path matches reality).
async function fetchSubscription(panelDomain: string, token: string): Promise<string | null> {
    if (token === "") return null;
    const url = `https://${panelDomain}/api/v1/subscription/${token}`;
    try {
        // 8 s timeout. Cover-site responses arrive in <1 s; a
        // longer-than-8 s wait means caddy / panel is wedged.
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        return await res.text();
    } catch {
        return null;
    }
}

// Resolve the panel domain. Prefer the explicit PANEL_DOMAIN env
// (set by install.sh), fall back to `panel.${DOMAIN}`. Same
// rule as core/ct-server-core/src/util/domain.rs::panel_domain.
function resolvePanelDomain(env: NodeJS.ProcessEnv): string {
    const explicit = (env["PANEL_DOMAIN"] ?? "").trim();
    if (explicit !== "") return explicit;
    const apex = (env["DOMAIN"] ?? "").trim();
    if (apex !== "") return `panel.${apex}`;
    return "";
}

async function collectRows(panelDomain: string): Promise<DriftRow[]> {
    const dbRows = await dumpDbRows();
    const naiveRaw = await dumpNaiveJson();
    const naiveUsers = naiveRaw === null ? [] : parseNaiveJsonAuth(naiveRaw);
    const naiveByUsername = new Map<string, string>();
    for (const u of naiveUsers) {
        naiveByUsername.set(u.username, u.password);
    }

    // Subscription fetch is the slowest layer (HTTPS round-trip per
    // account). Parallelise — each fetch is independent. We cap
    // concurrency at 8 so a panel sized for tens of accounts
    // doesn't get hammered by self-traffic during the audit.
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
        // The subscription manifest can carry multiple profiles in
        // principle. In our deployment there's one server per
        // account; match the username of the row's profile to
        // detect drift.
        const subForRow =
            subParsed === null
                ? null
                : (subParsed.profiles.find((p) => p.username === dbRow.username)?.password ?? null);
        const naiveForRow = naiveByUsername.has(dbRow.username)
            ? naiveByUsername.get(dbRow.username)!
            : null;
        rows.push({
            accountId: dbRow.id,
            username: dbRow.username,
            db: dbRow.cleartext,
            naive: naiveForRow,
            subscription: subForRow,
        });
    }

    // Phantom naive users: a user/password baked into naive.json
    // whose username has no DB row. Typically a deleted account
    // whose naive.json wasn't re-rendered. Surface as rows with
    // db=null.
    const dbUsernames = new Set(dbRows.map((r) => r.username));
    for (const u of naiveUsers) {
        if (!dbUsernames.has(u.username)) {
            rows.push({
                accountId: -1,
                username: u.username,
                db: null,
                naive: u.password,
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
                process.stdout.write(`\nok: ${report.findings.length} accounts, all three layers aligned\n`);
            } else {
                process.stdout.write(
                    `\nFAIL: ${drifted} drift, ${warned} warn across ${report.findings.length} accounts\n` +
                        `Repair: ./ct render naive          # if naive.json drifts from DB\n` +
                        `        Filament UI Regenerate-pw  # if DB cleartext is stale\n`,
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
