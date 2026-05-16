// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/drift-check.ts — three-way cleartext drift detection.
//
// Original incident: the credential-lock guard reported OK (hashes
// and manifests matched) but the *cleartext* password the DB
// stored, the password the rendered proxy config carried, and the
// password the panel's subscription endpoint handed back to clients
// had silently diverged on prior credential rotations. The strict
// component check is structurally unaware of that divergence — it
// compares lock-hashes, not the values clients actually authenticate
// with.
//
// This module pins the **cleartext** values at all three layers
// to be byte-equal. If they aren't, that's a real drift the
// operator must repair (`./ct render naive` or a Filament
// regenerate-password) before any client can connect.
//
// Naming history (the field name has tracked architecture cuts):
//
//   v0.1.x  DriftRow.singbox    — /etc/sing-box/config.json
//   v0.2.x  DriftRow.caddyfile  — /etc/caddy/Caddyfile basic_auth
//   v0.3.x  DriftRow.naive      — /data/config/naive.json
//
// The v0.3.x source of truth is the ct-naive supervisor's input
// file: a JSON blob carrying the single active account's user +
// password. (Naive's server mode supports one credential per
// listener; the multi-account drift detector currently surfaces
// "DB has N accounts, naive.json carries 1" as a finding — once
// multi-account-on-naive lands the parser will extend to cover N
// users.)
//
// Pure functions only. Anything that touches docker / fetch lives
// in tasks/drift.ts; the parsing, comparison, and reporting shapes
// are pinned here so tests can exercise them without a running
// compose stack.

// One (username, password) pair extracted from the naive.json
// rendered at /data/config/naive.json. Same shape v0.2.x called
// BasicAuthUser; renamed remains compatible.
export interface BasicAuthUser {
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
    // missed in DB, or naive.json carries a different username, or
    // the subscription endpoint returned cover-site / 404. Distinct
    // from "" (empty string), which means a layer EXPLICITLY
    // produced an empty password — that's still a drift if the
    // others have a value.
    readonly db: string | null;
    readonly naive: string | null;
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

// Parse the v0.3.x naive.json into a BasicAuthUser[] for shape
// compatibility with v0.2.x's parseCaddyfileBasicAuth. Returns an
// empty array on any parse / shape error — degrades to "no
// credentials found" so the upstream classifier can surface that
// as a real drift instead of throwing here and breaking the whole
// audit.
//
// Schema mirror: core/ct-server-core/src/naive/mod.rs::NaiveConfig
// + docker/naive/supervisor.ts::NaiveCtConfig. The drift checker
// only cares about (user, password) — other fields are ignored.
export function parseNaiveJsonAuth(rawText: string): BasicAuthUser[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        return [];
    }
    if (typeof parsed !== "object" || parsed === null) return [];
    const user = (parsed as { user?: unknown }).user;
    const password = (parsed as { password?: unknown }).password;
    if (typeof user !== "string" || typeof password !== "string") return [];
    // An empty user OR empty password means "the renderer wrote the
    // stub" — naive supervisor will refuse to spawn until both are
    // populated, and drift should treat that as "naive layer has no
    // credentials" (== absent), not "naive carries empty creds".
    if (user === "" || password === "") return [];
    return [{ username: user, password }];
}

// Legacy parser — kept for migration windows where the operator
// still has a v0.2.x Caddyfile on disk while the v0.3.x naive.json
// hasn't been rendered yet. New v0.3.x call sites use
// parseNaiveJsonAuth above. Tests still cover this for the
// transitional period.
//
// Parses `basic_auth USER PASS` directives out of a v0.2.x
// rendered Caddyfile's forward_proxy block. Hand-tokenised rather
// than imposing a full Caddyfile grammar; tracks `{` / `}` depth
// to know we're inside a forward_proxy block.
export function parseCaddyfileBasicAuth(rawText: string): BasicAuthUser[] {
    const out: BasicAuthUser[] = [];
    let depth = 0;
    let forwardProxyOpenAtDepth: number | null = null;
    for (const rawLine of rawText.split("\n")) {
        const commentIdx = rawLine.indexOf("#");
        const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trim();
        if (line.length === 0) continue;
        let consumed = "";
        for (let i = 0; i < line.length; i++) {
            const ch = line[i]!;
            if (ch === "{") {
                const directive = consumed.trim();
                depth++;
                if (
                    forwardProxyOpenAtDepth === null &&
                    directive.split(/\s+/).at(-1) === "forward_proxy"
                ) {
                    forwardProxyOpenAtDepth = depth;
                }
                consumed = "";
            } else if (ch === "}") {
                if (forwardProxyOpenAtDepth !== null && depth === forwardProxyOpenAtDepth) {
                    forwardProxyOpenAtDepth = null;
                }
                if (depth > 0) depth--;
                consumed = "";
            } else {
                consumed += ch;
            }
        }
        if (forwardProxyOpenAtDepth === null) continue;
        const m = consumed.trim().match(/^basic_auth\s+(\S+)\s+(\S+)\s*$/);
        if (m) {
            out.push({ username: m[1]!, password: m[2]! });
        }
    }
    return out;
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
//   - DB has cleartext, naive rendered an empty/missing       → fail
//     (next CONNECT will be rejected for "no such user").
//   - DB has cleartext, subscription returned cover-site
//     (null body)                                              → warn
//     (token may be expired, account disabled, or the panel
//     rate-limited us — investigate but not necessarily fatal).
//   - DB row missing entirely                                  → fail
//     (naive.json has a phantom user; remove via the panel).
//
// The summary string names which layers carry which values, NOT
// the values themselves — leaking cleartext into operator output
// is a separate audit failure even on a local terminal.
export function classifyRow(row: DriftRow): DriftFinding {
    const db = row.db;
    const nv = row.naive;
    const sub = row.subscription;

    if (db === null && nv === null && sub === null) {
        return {
            accountId: row.accountId,
            username: row.username,
            severity: "fail",
            summary: "no layer carries this account — phantom row, run `./ct render naive`",
        };
    }

    if (db === null) {
        return {
            accountId: row.accountId,
            username: row.username,
            severity: "fail",
            summary: "DB row missing but naive/subscription still reference it; phantom account",
        };
    }

    if (nv === null || nv === "") {
        return {
            accountId: row.accountId,
            username: row.username,
            severity: "fail",
            summary: "DB has cleartext, naive.json rendered no password — `./ct render naive` needed",
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
    if (db !== nv || db !== sub) {
        const which: string[] = [];
        if (db !== nv) which.push("db↔naive");
        if (db !== sub) which.push("db↔subscription");
        if (nv !== sub && db === nv) which.push("naive↔subscription");
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
    lines.push("account_id  username                    db        naive     subscription  finding");
    lines.push("──────────  ──────────────────────────  ────────  ────────  ────────────  ──────────────────────────────────");
    for (const row of report.rows) {
        const finding = report.findings.find(
            (f) => f.accountId === row.accountId && f.username === row.username,
        );
        const tag = ({ ok: "  OK", warn: "WARN", fail: "FAIL" } as const)[finding?.severity ?? "fail"];
        const cellDb = row.db === null ? "absent" : row.db === "" ? "EMPTY" : "present";
        const cellNv = row.naive === null ? "absent" : row.naive === "" ? "EMPTY" :
            (row.db !== null && row.naive === row.db ? "same" : "DIFF");
        const cellSub = row.subscription === null ? "absent" : row.subscription === "" ? "EMPTY" :
            (row.db !== null && row.subscription === row.db ? "same" : "DIFF");
        lines.push(
            `${String(row.accountId).padEnd(10)}  ${row.username.slice(0, 26).padEnd(26)}  ${cellDb.padEnd(8)}  ${cellNv.padEnd(8)}  ${cellSub.padEnd(12)}  ${tag}  ${finding?.summary ?? ""}`,
        );
    }
    return lines.join("\n");
}
