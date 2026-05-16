// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/drift-check.ts — three-way cleartext drift detection.
//
// Today's incident: the credential-lock guard reported OK (hashes
// and manifests matched) but the *cleartext* password the DB
// stored, the password the rendered sing-box config carried, and
// the password the panel's subscription endpoint handed back to
// clients had silently diverged on prior credential rotations.
// The strict component check is structurally unaware of that
// divergence — it compares lock-hashes, not the values clients
// actually authenticate with.
//
// This module pins the **cleartext** values at all three layers
// to be byte-equal. If they aren't, that's a real drift the
// operator must repair (`./ct render singbox` or a Filament
// regenerate-password) before any client can connect.
//
// Layers checked:
//
//   db          ProxyAccount::password_cleartext_encrypted, decrypted via
//               Laravel Crypt inside `docker compose exec panel
//               php artisan tinker` (same primitive auto-sync uses).
//
//   sing-box    The literal password emitted into
//               /etc/sing-box/config.json by the renderer — what
//               the running naive-in actually compares incoming
//               CONNECTs against.
//
//   subscription
//               The cleartext field inside the panel's
//               /api/v1/subscription/{token} JSON response — what
//               clients import and store in config.json.
//
// Pure functions only. Anything that touches docker / fetch lives
// in tasks/drift.ts; the parsing, comparison, and reporting
// shapes are pinned here so tests can exercise them without a
// running compose stack.

// One row in the rendered sing-box `users` array (subset; ignore
// other fields naive may grow).
export interface SingBoxUser {
    readonly username: string;
    readonly password: string;
}

// The minimum shape the subscription endpoint emits.
// SubscriptionManifestV1 carries more, but the drift check only
// needs the credential view.
export interface SubscriptionProfile {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly password: string;
}

export interface SubscriptionResponse {
    readonly version: number;
    readonly server: string;
    readonly profiles: readonly SubscriptionProfile[];
}

// What each layer reported for one (account_id, username) row.
export interface DriftRow {
    readonly accountId: number;
    readonly username: string;
    // null means "the layer could not produce a value" — the row
    // missed in DB, or sing-box config has no such user, or the
    // subscription endpoint returned cover-site / 404. Distinct
    // from "" (empty string), which means a layer EXPLICITLY
    // produced an empty password — that's still a drift if the
    // others have a value.
    readonly db: string | null;
    readonly singbox: string | null;
    readonly subscription: string | null;
}

export type DriftSeverity = "ok" | "warn" | "fail";

export interface DriftFinding {
    readonly accountId: number;
    readonly username: string;
    readonly severity: DriftSeverity;
    // Human-readable single-line explanation.
    readonly summary: string;
}

export interface DriftReport {
    readonly rows: readonly DriftRow[];
    readonly findings: readonly DriftFinding[];
    readonly ok: boolean;
}

// Parse the literal `users` array out of a rendered sing-box
// config.json. We hand-walk JSON.parse(..).inbounds[].users
// rather than imposing a full schema — the renderer is free to
// grow inbound knobs without breaking the credential extractor.
//
// Returns [] when no naive inbound is present (caller treats as
// "rendered config has zero credentials"). Throws on malformed
// JSON so the caller can surface a render-broken state distinct
// from a credentialless one.
export function parseSingBoxUsers(rawJson: string): SingBoxUser[] {
    const root = JSON.parse(rawJson) as unknown;
    if (typeof root !== "object" || root === null) return [];
    const inbounds = (root as { inbounds?: unknown }).inbounds;
    if (!Array.isArray(inbounds)) return [];
    const users: SingBoxUser[] = [];
    for (const inbound of inbounds) {
        if (typeof inbound !== "object" || inbound === null) continue;
        if ((inbound as { type?: unknown }).type !== "naive") continue;
        const rawUsers = (inbound as { users?: unknown }).users;
        if (!Array.isArray(rawUsers)) continue;
        for (const u of rawUsers) {
            if (typeof u !== "object" || u === null) continue;
            const username = (u as { username?: unknown }).username;
            const password = (u as { password?: unknown }).password;
            if (typeof username !== "string" || typeof password !== "string") continue;
            users.push({ username, password });
        }
    }
    return users;
}

// Parse the subscription endpoint's JSON body. Returns null for
// the cover-site path (the panel returns the FakeSite HTML on
// any failure, which is not JSON) so callers can distinguish
// "endpoint refused us" from "endpoint returned credentials".
export function parseSubscriptionResponse(rawBody: string): SubscriptionResponse | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawBody);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const version = (parsed as { version?: unknown }).version;
    const server = (parsed as { server?: unknown }).server;
    const profilesRaw = (parsed as { profiles?: unknown }).profiles;
    if (typeof version !== "number") return null;
    if (typeof server !== "string") return null;
    if (!Array.isArray(profilesRaw)) return null;
    const profiles: SubscriptionProfile[] = [];
    for (const p of profilesRaw) {
        if (typeof p !== "object" || p === null) continue;
        const host = (p as { host?: unknown }).host;
        const port = (p as { port?: unknown }).port;
        const username = (p as { username?: unknown }).username;
        const password = (p as { password?: unknown }).password;
        if (
            typeof host !== "string" ||
            typeof port !== "number" ||
            typeof username !== "string" ||
            typeof password !== "string"
        ) {
            continue;
        }
        profiles.push({ host, port, username, password });
    }
    return { version, server, profiles };
}

// Classify one row's three values into a finding. The contract:
//
//   - All three layers reported the same non-empty string → ok.
//   - Any pair of present-non-empty layers disagree           → fail.
//   - DB has cleartext, sing-box rendered an empty/missing  → fail
//     (next CONNECT will be rejected for "no such user").
//   - DB has cleartext, subscription returned cover-site
//     (null body)                                              → warn
//     (token may be expired, account disabled, or the panel
//     rate-limited us — investigate but not necessarily fatal).
//   - DB row missing entirely                                  → fail
//     (sing-box has a phantom user; remove via the panel).
//
// The summary string names which layers carry which values, NOT
// the values themselves — leaking cleartext into operator output
// is a separate audit failure even on a local terminal.
export function classifyRow(row: DriftRow): DriftFinding {
    const db = row.db;
    const sb = row.singbox;
    const sub = row.subscription;

    if (db === null && sb === null && sub === null) {
        return {
            accountId: row.accountId,
            username: row.username,
            severity: "fail",
            summary: "no layer carries this account — phantom row, run `./ct render singbox`",
        };
    }

    if (db === null) {
        return {
            accountId: row.accountId,
            username: row.username,
            severity: "fail",
            summary: "DB row missing but sing-box/subscription still reference it; phantom account",
        };
    }

    if (sb === null || sb === "") {
        return {
            accountId: row.accountId,
            username: row.username,
            severity: "fail",
            summary: "DB has cleartext, sing-box rendered no password — `./ct render singbox` needed",
        };
    }

    if (sub === null) {
        // Cover-site / non-JSON path. Could be: token wrong,
        // rate-limit hit, account disabled, APP_KEY broken. Always
        // worth a look but not a structural drift on its own.
        return {
            accountId: row.accountId,
            username: row.username,
            severity: "warn",
            summary: "subscription endpoint returned cover-site (token wrong, rate-limit, or APP_KEY?)",
        };
    }

    // All three present. The actual drift test.
    if (db !== sb || db !== sub) {
        const which: string[] = [];
        if (db !== sb) which.push("db↔singbox");
        if (db !== sub) which.push("db↔subscription");
        if (sb !== sub && db === sb) which.push("singbox↔subscription");
        return {
            accountId: row.accountId,
            username: row.username,
            severity: "fail",
            summary: `cleartext drift between ${which.join(" + ")}; clients will hit auth-fail cover-site until aligned`,
        };
    }

    return {
        accountId: row.accountId,
        username: row.username,
        severity: "ok",
        summary: "all three layers agree on cleartext",
    };
}

export function buildReport(rows: readonly DriftRow[]): DriftReport {
    const findings = rows.map(classifyRow);
    const ok = findings.every((f) => f.severity === "ok");
    return { rows, findings, ok };
}

// Render a human-readable table summary. Cleartext values are NEVER
// printed — only present/absent status and same/diff vs DB.
export function renderTable(report: DriftReport): string {
    const lines: string[] = [];
    lines.push("account_id  username                    db        singbox   subscription  finding");
    lines.push("──────────  ──────────────────────────  ────────  ────────  ────────────  ──────────────────────────────────");
    for (const row of report.rows) {
        const finding = report.findings.find(
            (f) => f.accountId === row.accountId && f.username === row.username,
        );
        const tag = ({ ok: "  OK", warn: "WARN", fail: "FAIL" } as const)[finding?.severity ?? "fail"];
        const cellDb = row.db === null ? "absent" : row.db === "" ? "EMPTY" : "present";
        const cellSb = row.singbox === null ? "absent" : row.singbox === "" ? "EMPTY" :
            (row.db !== null && row.singbox === row.db ? "same" : "DIFF");
        const cellSub = row.subscription === null ? "absent" : row.subscription === "" ? "EMPTY" :
            (row.db !== null && row.subscription === row.db ? "same" : "DIFF");
        lines.push(
            `${String(row.accountId).padEnd(10)}  ${row.username.slice(0, 26).padEnd(26)}  ${cellDb.padEnd(8)}  ${cellSb.padEnd(8)}  ${cellSub.padEnd(12)}  ${tag}  ${finding?.summary ?? ""}`,
        );
    }
    return lines.join("\n");
}
