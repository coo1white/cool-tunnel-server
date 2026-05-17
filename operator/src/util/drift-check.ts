// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/drift-check.ts — three-way credential drift detection.
//
// Original incident: the credential-lock guard reported OK (hashes
// and manifests matched) but the *cleartext* credential the DB
// stored, the credential the rendered proxy config carried, and
// the credential the panel's subscription endpoint handed back to
// clients had silently diverged on prior credential rotations. The
// strict component check is structurally unaware of that divergence
// — it compares lock-hashes, not values clients authenticate with.
//
// This module pins the **cleartext** value at all three layers to
// be byte-equal. If they aren't, that's a real drift the operator
// must repair (`./ct render singbox` or a Filament regenerate-UUID)
// before any client can connect.
//
// Naming history (the field name has tracked architecture cuts):
//
//   v0.1.x  DriftRow.singbox    — /etc/sing-box/config.json (legacy)
//   v0.2.x  DriftRow.caddyfile  — /etc/caddy/Caddyfile basic_auth
//   v0.3.x  DriftRow.naive      — /data/config/naive.json
//   v0.4.x  DriftRow.singbox    — /data/config/singbox.json (NEW)
//
// The v0.4.x "credential" is the VLESS UUID per ProxyAccount (which
// replaced the cleartext password in v0.4.0's schema migration).
// All three layers carry the UUID; drift means the running sing-box
// is authenticating a different UUID than the DB stores or the
// subscription endpoint hands out.

/**
 * One (username, uuid) pair extracted from /data/config/singbox.json.
 * Username comes from the inbound user's `name` field; uuid is the
 * VLESS credential.
 */
export interface SingboxUser {
    readonly username: string;
    readonly uuid: string;
}

/**
 * Back-compat alias — v0.3.x called the same shape BasicAuthUser.
 * Tests using the old name keep compiling.
 */
export type BasicAuthUser = SingboxUser;

// The minimum shape the subscription endpoint emits.
// SubscriptionManifestV1 carries more, but the drift check only
// needs the credential view.
export interface SubscriptionProfile {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    /**
     * v0.4.x: this is the VLESS UUID. v0.3.x called it "password".
     * The wire-shape change to sing-box config snippet is a separate
     * concern handled by the manifest schema; this field tracks
     * whatever credential the client uses.
     */
    readonly uuid: string;
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
    // null = layer could not produce a value (row missed in DB,
    // singbox.json has no user with that username, subscription
    // endpoint returned cover-site). Distinct from "" which means
    // a layer EXPLICITLY produced an empty value.
    readonly db: string | null;
    readonly singbox: string | null;
    readonly subscription: string | null;
}

export type DriftSeverity = "ok" | "warn" | "fail";

export interface DriftFinding {
    readonly accountId: number;
    readonly username: string;
    readonly severity: DriftSeverity;
    readonly summary: string;
}

export interface DriftReport {
    readonly rows: readonly DriftRow[];
    readonly findings: readonly DriftFinding[];
    readonly ok: boolean;
}

/**
 * Parse the v0.4.x sing-box config.json into a SingboxUser[].
 * Returns an empty array on any parse / shape error — degrades
 * to "no credentials found" so the upstream classifier surfaces
 * that as a real drift rather than throwing here and breaking the
 * whole audit.
 *
 * Schema mirror: singbox-core/src/config/render.ts ::
 *   SingboxConfig.inbounds[] of type "vless" carries users[],
 *   each { name, uuid, flow }.
 *
 * We extract from EVERY vless inbound (multi-account multi-port is
 * a hypothetical v0.4.x followup; today's render produces one
 * inbound with all users, but the parser is forward-compatible).
 */
export function parseSingboxJsonUsers(rawText: string): SingboxUser[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        return [];
    }
    if (typeof parsed !== "object" || parsed === null) return [];
    const inbounds = (parsed as { inbounds?: unknown }).inbounds;
    if (!Array.isArray(inbounds)) return [];

    const out: SingboxUser[] = [];
    for (const inb of inbounds) {
        if (typeof inb !== "object" || inb === null) continue;
        if ((inb as { type?: unknown }).type !== "vless") continue;
        const users = (inb as { users?: unknown }).users;
        if (!Array.isArray(users)) continue;
        for (const u of users) {
            if (typeof u !== "object" || u === null) continue;
            const name = (u as { name?: unknown }).name;
            const uuid = (u as { uuid?: unknown }).uuid;
            if (typeof name !== "string" || typeof uuid !== "string") continue;
            if (name === "" || uuid === "") continue;
            out.push({ username: name, uuid });
        }
    }
    return out;
}

// Parse the subscription endpoint's JSON body.
// Returns null on cover-site / non-JSON so callers distinguish
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
        // The wire field on the subscription manifest is renamed
        // from "password" (v0.3.x naive) to "uuid" (v0.4.x VLESS),
        // but we accept either for the duration of the transition
        // window — older client builds will be sending the old name.
        const credential =
            (p as { uuid?: unknown }).uuid ?? (p as { password?: unknown }).password;
        if (
            typeof host !== "string" ||
            typeof port !== "number" ||
            typeof username !== "string" ||
            typeof credential !== "string"
        ) {
            continue;
        }
        profiles.push({ host, port, username, uuid: credential });
    }
    return { version, server, profiles };
}

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
            summary:
                "DB row missing but singbox/subscription still reference it; phantom account",
        };
    }

    if (sb === null || sb === "") {
        return {
            accountId: row.accountId,
            username: row.username,
            severity: "fail",
            summary:
                "DB has uuid, singbox.json has no matching user — `./ct render singbox` needed",
        };
    }

    if (sub === null) {
        return {
            accountId: row.accountId,
            username: row.username,
            severity: "warn",
            summary:
                "subscription endpoint returned cover-site (token wrong, rate-limit, or APP_KEY?)",
        };
    }

    if (db !== sb || db !== sub) {
        const which: string[] = [];
        if (db !== sb) which.push("db↔singbox");
        if (db !== sub) which.push("db↔subscription");
        if (sb !== sub && db === sb) which.push("singbox↔subscription");
        return {
            accountId: row.accountId,
            username: row.username,
            severity: "fail",
            summary: `uuid drift between ${which.join(" + ")}; clients will hit auth-fail cover-site until aligned`,
        };
    }

    return {
        accountId: row.accountId,
        username: row.username,
        severity: "ok",
        summary: "all three layers agree on the VLESS UUID",
    };
}

export function buildReport(rows: readonly DriftRow[]): DriftReport {
    const findings = rows.map(classifyRow);
    const ok = findings.every((f) => f.severity === "ok");
    return { rows, findings, ok };
}

/**
 * Render a human-readable table summary. UUIDs are NEVER printed —
 * only present/absent status and same/diff vs DB.
 */
export function renderTable(report: DriftReport): string {
    const lines: string[] = [];
    lines.push(
        "account_id  username                    db        singbox   subscription  finding",
    );
    lines.push(
        "──────────  ──────────────────────────  ────────  ────────  ────────────  ──────────────────────────────────",
    );
    for (const row of report.rows) {
        const finding = report.findings.find(
            (f) => f.accountId === row.accountId && f.username === row.username,
        );
        const tag = ({ ok: "  OK", warn: "WARN", fail: "FAIL" } as const)[
            finding?.severity ?? "fail"
        ];
        const cellDb = row.db === null ? "absent" : row.db === "" ? "EMPTY" : "present";
        const cellSb =
            row.singbox === null
                ? "absent"
                : row.singbox === ""
                  ? "EMPTY"
                  : row.db !== null && row.singbox === row.db
                    ? "same"
                    : "DIFF";
        const cellSub =
            row.subscription === null
                ? "absent"
                : row.subscription === ""
                  ? "EMPTY"
                  : row.db !== null && row.subscription === row.db
                    ? "same"
                    : "DIFF";
        lines.push(
            `${String(row.accountId).padEnd(10)}  ${row.username
                .slice(0, 26)
                .padEnd(26)}  ${cellDb.padEnd(8)}  ${cellSb.padEnd(8)}  ${cellSub.padEnd(12)}  ${tag}  ${finding?.summary ?? ""}`,
        );
    }
    return lines.join("\n");
}
