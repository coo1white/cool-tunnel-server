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
// operator must repair (`./ct render caddyfile` or a Filament
// regenerate-password) before any client can connect.
//
// v0.2.0+: the proxy server is Caddy with the klzgrad/forwardproxy
// plugin; the rendered config is the Caddyfile. v0.1.x was sing-box
// + /etc/sing-box/config.json. The drift-check field is named
// `caddyfile` accordingly. (Pre-v0.2.0 callers read
// `DriftRow.singbox`; that name was retired with the architecture
// cut.)
//
// Layers checked:
//
//   db          ProxyAccount::password_cleartext_encrypted, decrypted via
//               Laravel Crypt inside `docker compose exec panel
//               php artisan tinker` (same primitive auto-sync uses).
//
//   caddyfile   The literal password emitted into the rendered
//               Caddyfile's `forward_proxy { basic_auth … }` block
//               — what Caddy actually compares incoming CONNECTs
//               against.
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

// One (username, password) pair extracted from a rendered
// Caddyfile's `forward_proxy { basic_auth USER PASS }` directives.
// Same shape v0.1.x called `SingBoxUser`; renamed at the v0.2.0
// architecture cut.
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
    // missed in DB, or the Caddyfile has no matching basic_auth
    // directive, or the subscription endpoint returned cover-site /
    // 404. Distinct from "" (empty string), which means a layer
    // EXPLICITLY produced an empty password — that's still a drift
    // if the others have a value.
    readonly db: string | null;
    readonly caddyfile: string | null;
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

// Parse `basic_auth USER PASS` directives out of a rendered
// Caddyfile's forward_proxy block.
//
// We hand-tokenise rather than impose a full Caddyfile grammar
// — the renderer is free to grow new forward_proxy options
// without breaking the credential extractor. The rules:
//
//   - Track `{` / `}` depth to know we're inside a
//     `forward_proxy` block (depth becomes "interesting" when the
//     directive opens, returns "uninteresting" when the matching
//     `}` closes).
//   - At every line, after stripping leading whitespace, match
//     `^basic_auth\s+(\S+)\s+(\S+)\s*$`. Comments and other
//     directives are ignored. `basic_auth` outside a forward_proxy
//     block is ignored too — there's no legitimate place for it
//     in our rendered Caddyfile, but skipping it costs nothing.
//   - Quoted username/password (`basic_auth "a b" "c d"`) is
//     out of scope: our renderer emits unquoted whitespace-free
//     tokens by design (see core/ct-server-core/src/caddy/mod.rs::
//     is_caddyfile_password_safe). A future renderer that emits
//     quoted forms would extend this parser.
//
// Returns [] for a Caddyfile with no forward_proxy block or no
// `basic_auth` lines inside one. Never throws — even on malformed
// Caddyfile content we degrade to "no credentials found", because
// the upstream classifier already encodes "rendered config has
// no users" as a drift finding.
export function parseCaddyfileBasicAuth(rawText: string): BasicAuthUser[] {
    const out: BasicAuthUser[] = [];
    // Stack of `{` opens we're inside, paired with whether the
    // most recent open was the `forward_proxy { ... }` we care
    // about. We don't care about other block types — just track
    // whether we're inside ONE forward_proxy somewhere up the stack.
    let depth = 0;
    let forwardProxyOpenAtDepth: number | null = null;
    for (const rawLine of rawText.split("\n")) {
        // Strip line comments (`# …`). Caddyfile allows comments
        // anywhere whitespace is allowed; the simple-substring
        // approach is correct because passwords containing `#`
        // are rejected upstream by is_caddyfile_password_safe.
        const commentIdx = rawLine.indexOf("#");
        const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trim();
        if (line.length === 0) continue;
        // Detect opening / closing braces. A line can carry both a
        // directive AND a `{` (e.g. `forward_proxy {`), or be a
        // bare `}`. We process bracket transitions per character.
        let consumed = "";
        for (let i = 0; i < line.length; i++) {
            const ch = line[i]!;
            if (ch === "{") {
                // The "consumed so far" is the directive token
                // that's opening this block. Strip trailing space.
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
        // The "consumed" tail is the directive on this line (if
        // any). Check it for basic_auth, but only if we're
        // currently inside a forward_proxy block.
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
//   - DB has cleartext, Caddyfile rendered an empty/missing → fail
//     (next CONNECT will be rejected for "no such user").
//   - DB has cleartext, subscription returned cover-site
//     (null body)                                              → warn
//     (token may be expired, account disabled, or the panel
//     rate-limited us — investigate but not necessarily fatal).
//   - DB row missing entirely                                  → fail
//     (Caddyfile has a phantom user; remove via the panel).
//
// The summary string names which layers carry which values, NOT
// the values themselves — leaking cleartext into operator output
// is a separate audit failure even on a local terminal.
export function classifyRow(row: DriftRow): DriftFinding {
    const db = row.db;
    const cf = row.caddyfile;
    const sub = row.subscription;

    if (db === null && cf === null && sub === null) {
        return {
            accountId: row.accountId,
            username: row.username,
            severity: "fail",
            summary: "no layer carries this account — phantom row, run `./ct render caddyfile`",
        };
    }

    if (db === null) {
        return {
            accountId: row.accountId,
            username: row.username,
            severity: "fail",
            summary: "DB row missing but caddyfile/subscription still reference it; phantom account",
        };
    }

    if (cf === null || cf === "") {
        return {
            accountId: row.accountId,
            username: row.username,
            severity: "fail",
            summary: "DB has cleartext, caddyfile rendered no password — `./ct render caddyfile` needed",
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
    if (db !== cf || db !== sub) {
        const which: string[] = [];
        if (db !== cf) which.push("db↔caddyfile");
        if (db !== sub) which.push("db↔subscription");
        if (cf !== sub && db === cf) which.push("caddyfile↔subscription");
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
    lines.push("account_id  username                    db        caddyfile  subscription  finding");
    lines.push("──────────  ──────────────────────────  ────────  ─────────  ────────────  ──────────────────────────────────");
    for (const row of report.rows) {
        const finding = report.findings.find(
            (f) => f.accountId === row.accountId && f.username === row.username,
        );
        const tag = ({ ok: "  OK", warn: "WARN", fail: "FAIL" } as const)[finding?.severity ?? "fail"];
        const cellDb = row.db === null ? "absent" : row.db === "" ? "EMPTY" : "present";
        const cellCf = row.caddyfile === null ? "absent" : row.caddyfile === "" ? "EMPTY" :
            (row.db !== null && row.caddyfile === row.db ? "same" : "DIFF");
        const cellSub = row.subscription === null ? "absent" : row.subscription === "" ? "EMPTY" :
            (row.db !== null && row.subscription === row.db ? "same" : "DIFF");
        lines.push(
            `${String(row.accountId).padEnd(10)}  ${row.username.slice(0, 26).padEnd(26)}  ${cellDb.padEnd(8)}  ${cellCf.padEnd(9)}  ${cellSub.padEnd(12)}  ${tag}  ${finding?.summary ?? ""}`,
        );
    }
    return lines.join("\n");
}
