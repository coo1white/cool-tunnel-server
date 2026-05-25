// SPDX-License-Identifier: AGPL-3.0-only
// SQLite storage and migrations for Better Auth + admin metadata.

import { mkdirSync, chmodSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { AdminRole } from "./roles";
import { requireRole } from "./roles";
import { validateEmail, validateUserId } from "./config";

export type AdminUserStatus = "active" | "disabled";
export const ADMIN_USER_STATUSES = ["active", "disabled"] as const;

export function openAdminDatabase(path: string): Database {
    const db = new Database(path, { create: true, strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
}

export interface AdminUserRow {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly role: AdminRole;
    readonly status: AdminUserStatus;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly disabledAt: string | null;
}

export interface AuditRow {
    readonly id: number;
    readonly actorUserId: string | null;
    readonly action: string;
    readonly targetType: string | null;
    readonly targetId: string | null;
    readonly detail: string | null;
    readonly createdAt: string;
}

export interface BootstrapTokenRow {
    readonly id: string;
    readonly tokenHash: string;
    readonly expiresAt: string;
    readonly usedAt: string | null;
    readonly createdAt: string;
}

export class AdminStorage {
    readonly db: Database;

    constructor(readonly path: string) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = openAdminDatabase(path);
    }

    close(): void {
        this.db.close();
    }

    migrate(): void {
        migrateAdminDatabase(this.db);
        try {
            chmodSync(this.path, 0o600);
        } catch {
            // Best effort for bind mounts.
        }
    }

    ownerExists(): boolean {
        const row = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user WHERE role = 'owner' AND status = 'active'").get();
        return (row?.n ?? 0) > 0;
    }

    ownerCount(): number {
        return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user WHERE role = 'owner' AND status = 'active'").get()?.n ?? 0;
    }

    userCount(): number {
        return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user").get()?.n ?? 0;
    }

    getUserById(id: string): AdminUserRow | null {
        validateUserId(id);
        const row = this.db.query<AdminUserRow, [string]>(
            "SELECT id, name, email, role, status, disabledAt, createdAt, updatedAt FROM user WHERE id = ?",
        ).get(id);
        return row ? normalizeUserRow(row) : null;
    }

    getUserByEmail(email: string): AdminUserRow | null {
        const normalized = validateEmail(email);
        const row = this.db.query<AdminUserRow, [string]>(
            "SELECT id, name, email, role, status, disabledAt, createdAt, updatedAt FROM user WHERE email = ?",
        ).get(normalized);
        return row ? normalizeUserRow(row) : null;
    }

    listUsers(): AdminUserRow[] {
        return this.db.query<AdminUserRow, []>(
            "SELECT id, name, email, role, status, disabledAt, createdAt, updatedAt FROM user ORDER BY role = 'owner' DESC, status = 'active' DESC, email ASC",
        ).all().map(normalizeUserRow);
    }

    updateUser(userId: string, input: { readonly email?: string; readonly name?: string; readonly role?: AdminRole }): AdminUserRow {
        validateUserId(userId);
        const nextEmail = input.email === undefined ? undefined : validateEmail(input.email);
        const nextName = input.name === undefined ? undefined : input.name.trim();
        const nextRole = input.role === undefined ? undefined : requireRole(input.role);
        if (nextName !== undefined && (nextName.length < 1 || nextName.length > 120)) {
            throw new Error("name must be 1-120 characters");
        }
        const updated = this.db.transaction((id: string, timestamp: string) => {
            const current = this.getUserById(id);
            if (!current) return null;
            if (nextRole && current.role === "owner" && nextRole !== "owner" && this.ownerCount() <= 1) {
                throw new Error("cannot remove the last owner account");
            }
            this.db.query(
                `UPDATE user
                 SET email = COALESCE(?, email),
                     name = COALESCE(?, name),
                     role = COALESCE(?, role),
                     updatedAt = ?
                 WHERE id = ?`,
            ).run(nextEmail ?? null, nextName ?? null, nextRole ?? null, timestamp, id);
            return this.getUserById(id);
        })(userId, new Date().toISOString());
        if (!updated) throw new Error(`user not found: ${userId}`);
        return updated;
    }

    setUserRole(userId: string, role: AdminRole): void {
        validateUserId(userId);
        requireRole(role);
        const result = this.db.transaction((id: string, nextRole: AdminRole, timestamp: string) => {
            const current = this.getUserById(id);
            if (!current) return { changes: 0 };
            if (current.role === "owner" && nextRole !== "owner" && this.ownerCount() <= 1) {
                throw new Error("cannot remove the last owner account");
            }
            return this.db.query(
                "UPDATE user SET role = ?, updatedAt = ? WHERE id = ?",
            ).run(nextRole, timestamp, id);
        })(userId, role, new Date().toISOString());
        if (result.changes !== 1) {
            throw new Error(`user not found: ${userId}`);
        }
    }

    setUserStatus(userId: string, status: AdminUserStatus): void {
        validateUserId(userId);
        requireUserStatus(status);
        const result = this.db.transaction((id: string, nextStatus: AdminUserStatus, timestamp: string) => {
            const current = this.getUserById(id);
            if (!current) return { changes: 0 };
            if (current.role === "owner" && current.status === "active" && nextStatus === "disabled" && this.ownerCount() <= 1) {
                throw new Error("cannot disable the last owner account");
            }
            const disabledAt = nextStatus === "disabled" ? timestamp : null;
            const changes = this.db.query(
                "UPDATE user SET status = ?, disabledAt = ?, updatedAt = ? WHERE id = ?",
            ).run(nextStatus, disabledAt, timestamp, id);
            if (nextStatus === "disabled") {
                this.deleteSessionsForUser(id);
            }
            return changes;
        })(userId, status, new Date().toISOString());
        if (result.changes !== 1) {
            throw new Error(`user not found: ${userId}`);
        }
    }

    setUserPasswordHash(userId: string, passwordHash: string): void {
        validateUserId(userId);
        if (!passwordHash) throw new Error("password hash is required");
        const result = this.db.transaction((id: string, hash: string, timestamp: string) => {
            const current = this.getUserById(id);
            if (!current) return { changes: 0 };
            const account = this.db.query<{ id: string }, [string]>(
                "SELECT id FROM account WHERE userId = ? AND providerId = 'credential' ORDER BY createdAt ASC LIMIT 1",
            ).get(id);
            if (!account) throw new Error("credential account not found for user");
            this.deleteSessionsForUser(id);
            return this.db.query("UPDATE account SET password = ?, updatedAt = ? WHERE id = ?").run(hash, timestamp, account.id);
        })(userId, passwordHash, new Date().toISOString());
        if (result.changes !== 1) {
            throw new Error(`user not found: ${userId}`);
        }
    }

    deleteSessionsForUser(userId: string): void {
        validateUserId(userId);
        this.db.query("DELETE FROM session WHERE userId = ?").run(userId);
    }

    deleteUser(userId: string): void {
        validateUserId(userId);
        const result = this.db.transaction((id: string) => {
            const current = this.getUserById(id);
            if (!current) return { changes: 0 };
            if (current.role === "owner" && current.status === "active" && this.ownerCount() <= 1) {
                throw new Error("cannot delete the last owner account");
            }
            return this.db.query("DELETE FROM user WHERE id = ?").run(id);
        })(userId);
        if (result.changes !== 1) {
            throw new Error(`user not found: ${userId}`);
        }
    }

    createCredentialUser(input: {
        readonly email: string;
        readonly name: string;
        readonly role: AdminRole;
        readonly passwordHash: string;
    }): AdminUserRow {
        const email = validateEmail(input.email);
        const name = input.name.trim();
        const role = requireRole(input.role);
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        const accountId = crypto.randomUUID();
        this.db.transaction(() => {
            if (this.getUserByEmail(email)) {
                throw new Error("admin user already exists for that email");
            }
            this.insertCredentialUser(id, accountId, email, name, role, input.passwordHash, now);
        })();
        const user = this.getUserById(id);
        if (!user) throw new Error("admin user creation failed");
        return user;
    }

    createFirstOwnerWithBootstrapToken(input: {
        readonly tokenHash: string;
        readonly email: string;
        readonly name: string;
        readonly passwordHash: string;
        readonly now?: Date;
    }): { ok: true; user: AdminUserRow; tokenId: string } | { ok: false; reason: "owner-exists" | "missing" | "used" | "expired" } {
        const email = validateEmail(input.email, "owner email");
        const name = input.name.trim();
        const now = (input.now ?? new Date()).toISOString();
        const userId = crypto.randomUUID();
        const accountId = crypto.randomUUID();
        return this.db.transaction(() => {
            if (this.ownerCount() > 0) return { ok: false as const, reason: "owner-exists" as const };
            const found = this.db.query<BootstrapTokenRow, [string]>(
                "SELECT id, tokenHash, expiresAt, usedAt, createdAt FROM bootstrap_token WHERE tokenHash = ?",
            ).get(input.tokenHash);
            if (!found) return { ok: false as const, reason: "missing" as const };
            if (found.usedAt !== null) return { ok: false as const, reason: "used" as const };
            if (new Date(found.expiresAt).getTime() <= new Date(now).getTime()) {
                return { ok: false as const, reason: "expired" as const };
            }
            if (this.getUserByEmail(email)) {
                throw new Error("admin user already exists for that email");
            }
            this.insertCredentialUser(userId, accountId, email, name, "owner", input.passwordHash, now);
            const consumed = this.db.query(
                "UPDATE bootstrap_token SET usedAt = ? WHERE id = ? AND usedAt IS NULL",
            ).run(now, found.id);
            if (consumed.changes !== 1) return { ok: false as const, reason: "used" as const };
            const user = this.getUserById(userId);
            if (!user) throw new Error("owner user creation failed");
            return { ok: true as const, user, tokenId: found.id };
        })();
    }

    private insertCredentialUser(
        userId: string,
        accountId: string,
        email: string,
        name: string,
        role: AdminRole,
        passwordHash: string,
        timestamp: string,
    ): void {
        this.db.query(
            "INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt, role, status, disabledAt) VALUES (?, ?, ?, 0, NULL, ?, ?, ?, 'active', NULL)",
        ).run(userId, name, email, timestamp, timestamp, role);
        this.db.query(
            `INSERT INTO account (
                id, accountId, providerId, userId, password, createdAt, updatedAt
            ) VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
        ).run(accountId, userId, userId, passwordHash, timestamp, timestamp);
    }

    createBootstrapToken(tokenHash: string, expiresAt: Date): string {
        const id = crypto.randomUUID();
        this.db.query(
            "INSERT INTO bootstrap_token (id, tokenHash, expiresAt, createdAt) VALUES (?, ?, ?, ?)",
        ).run(id, tokenHash, expiresAt.toISOString(), new Date().toISOString());
        return id;
    }

    createServerConfig(input: {
        readonly domain: string;
        readonly panelDomain: string;
        readonly acmeEmail: string;
        readonly acmeDirectory: string;
        readonly realityPrivateKey: string;
        readonly realityPublicKey: string;
        readonly realityDestHost: string;
        readonly realityShortIds: readonly string[];
    }): void {
        this.db.query(
            `INSERT INTO server_config (
                id, domain, panelDomain, acmeEmail, acmeDirectory,
                antiTrackingHideIp, antiTrackingHideVia, antiTrackingProbeResistance,
                antiTrackingDohResolver, http3Enabled,
                realityPrivateKey, realityPublicKey, realityDestHost, realityShortIds,
                createdAt, updatedAt
            ) VALUES (
                1, ?, ?, ?, ?,
                1, 1, 1,
                'https://dns.alidns.com/dns-query', 1,
                ?, ?, ?, ?,
                ?, ?
            )
            ON CONFLICT(id) DO UPDATE SET
                domain = excluded.domain,
                panelDomain = excluded.panelDomain,
                acmeEmail = excluded.acmeEmail,
                acmeDirectory = excluded.acmeDirectory,
                realityPrivateKey = COALESCE(NULLIF(server_config.realityPrivateKey, ''), excluded.realityPrivateKey),
                realityPublicKey = COALESCE(NULLIF(server_config.realityPublicKey, ''), excluded.realityPublicKey),
                realityDestHost = excluded.realityDestHost,
                realityShortIds = excluded.realityShortIds,
                updatedAt = excluded.updatedAt`,
        ).run(
            input.domain,
            input.panelDomain,
            input.acmeEmail,
            input.acmeDirectory,
            input.realityPrivateKey,
            input.realityPublicKey,
            input.realityDestHost,
            JSON.stringify(input.realityShortIds),
            new Date().toISOString(),
            new Date().toISOString(),
        );
    }

    consumeBootstrapToken(tokenHash: string, now = new Date()): BootstrapTokenRow | null {
        const row = this.db.transaction((hash: string, timestamp: string) => {
            const found = this.db.query<BootstrapTokenRow, [string]>(
                "SELECT id, tokenHash, expiresAt, usedAt, createdAt FROM bootstrap_token WHERE tokenHash = ?",
            ).get(hash);
            if (!found || found.usedAt !== null || new Date(found.expiresAt).getTime() <= new Date(timestamp).getTime()) {
                return null;
            }
            const result = this.db.query(
                "UPDATE bootstrap_token SET usedAt = ? WHERE id = ? AND usedAt IS NULL",
            ).run(timestamp, found.id);
            return result.changes === 1 ? found : null;
        })(tokenHash, now.toISOString());
        return row;
    }

    bootstrapTokenStatus(tokenHash: string, now = new Date()): "valid" | "missing" | "used" | "expired" {
        const row = this.db.query<BootstrapTokenRow, [string]>(
            "SELECT id, tokenHash, expiresAt, usedAt, createdAt FROM bootstrap_token WHERE tokenHash = ?",
        ).get(tokenHash);
        if (!row) return "missing";
        if (row.usedAt !== null) return "used";
        if (new Date(row.expiresAt).getTime() <= now.getTime()) return "expired";
        return "valid";
    }

    pruneExpiredBootstrapTokens(now = new Date()): void {
        this.db.query("DELETE FROM bootstrap_token WHERE expiresAt <= ? OR usedAt IS NOT NULL").run(now.toISOString());
    }

    audit(actorUserId: string | null, action: string, targetType?: string, targetId?: string, detail?: Record<string, unknown>): void {
        const safeDetail = detail ? JSON.stringify(maskAuditDetail(detail)) : null;
        this.db.query(
            "INSERT INTO audit_log (actorUserId, action, targetType, targetId, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(actorUserId, action, targetType ?? null, targetId ?? null, safeDetail, new Date().toISOString());
    }

    recentAudit(limit = 50): AuditRow[] {
        const clamped = Math.max(1, Math.min(200, Math.floor(limit)));
        return this.db.query<AuditRow, [number]>(
            "SELECT id, actorUserId, action, targetType, targetId, detail, createdAt FROM audit_log ORDER BY id DESC LIMIT ?",
        ).all(clamped);
    }
}

export function ensureServerConfig(storage: AdminStorage, input: {
    readonly domain: string;
    readonly panelDomain: string;
    readonly acmeEmail: string;
    readonly acmeDirectory: string;
    readonly realityPrivateKey: string;
    readonly realityPublicKey: string;
    readonly realityDestHost: string;
    readonly realityShortIds: readonly string[];
}): void {
    storage.createServerConfig(input);
}

function normalizeUserRow(row: AdminUserRow): AdminUserRow {
    return { ...row, email: validateEmail(row.email), role: requireRole(row.role), status: requireUserStatus(row.status), disabledAt: row.disabledAt ?? null };
}

export function requireUserStatus(value: unknown): AdminUserStatus {
    if (value === "active" || value === "disabled") {
        return value;
    }
    throw new Error(`invalid user status: ${String(value)} (expected one of: ${ADMIN_USER_STATUSES.join(", ")})`);
}

function maskAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(detail)) {
        if (/password|secret|token|key|uuid/i.test(key)) {
            out[key] = "<redacted>";
        } else {
            out[key] = value;
        }
    }
    return out;
}

export function migrateAdminDatabase(db: Database): void {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    createdAt DATE NOT NULL,
    updatedAt DATE NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','admin','operator','viewer')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    disabledAt DATE
);

CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    expiresAt DATE NOT NULL,
    token TEXT NOT NULL UNIQUE,
    createdAt DATE NOT NULL,
    updatedAt DATE NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS session_userId_idx ON session(userId);

CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    accessToken TEXT,
    refreshToken TEXT,
    idToken TEXT,
    accessTokenExpiresAt DATE,
    refreshTokenExpiresAt DATE,
    scope TEXT,
    password TEXT,
    createdAt DATE NOT NULL,
    updatedAt DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS account_userId_idx ON account(userId);

CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt DATE NOT NULL,
    createdAt DATE NOT NULL,
    updatedAt DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);

CREATE TABLE IF NOT EXISTS rateLimit (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    count INTEGER NOT NULL,
    lastRequest BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS bootstrap_token (
    id TEXT PRIMARY KEY,
    tokenHash TEXT NOT NULL UNIQUE,
    expiresAt DATE NOT NULL,
    usedAt DATE,
    createdAt DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS bootstrap_token_expiresAt_idx ON bootstrap_token(expiresAt);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actorUserId TEXT,
    action TEXT NOT NULL,
    targetType TEXT,
    targetId TEXT,
    detail TEXT,
    createdAt DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_createdAt_idx ON audit_log(createdAt);

CREATE TABLE IF NOT EXISTS server_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    domain TEXT NOT NULL,
    panelDomain TEXT NOT NULL,
    acmeEmail TEXT NOT NULL,
    acmeDirectory TEXT NOT NULL DEFAULT 'https://acme-v02.api.letsencrypt.org/directory',
    antiTrackingHideIp INTEGER NOT NULL DEFAULT 1,
    antiTrackingHideVia INTEGER NOT NULL DEFAULT 1,
    antiTrackingProbeResistance INTEGER NOT NULL DEFAULT 1,
    antiTrackingDohResolver TEXT NOT NULL DEFAULT 'https://dns.alidns.com/dns-query',
    http3Enabled INTEGER NOT NULL DEFAULT 1,
    realityPrivateKey TEXT NOT NULL,
    realityPublicKey TEXT NOT NULL,
    realityDestHost TEXT NOT NULL DEFAULT 'www.microsoft.com',
    realityShortIds TEXT NOT NULL DEFAULT '[""]',
    lastCaddyfileHash TEXT,
    lastRenderedAt DATE,
    createdAt DATE NOT NULL,
    updatedAt DATE NOT NULL
);
`);

    // Forward-compatible idempotent upgrades for databases created by
    // earlier Better Auth experiments.
    addColumnIfMissing(db, "user", "role", "TEXT NOT NULL DEFAULT 'viewer'");
    db.exec("UPDATE user SET role = 'viewer' WHERE role IS NULL OR role NOT IN ('owner','admin','operator','viewer')");
    addColumnIfMissing(db, "user", "status", "TEXT NOT NULL DEFAULT 'active'");
    addColumnIfMissing(db, "user", "disabledAt", "DATE");
    db.exec("UPDATE user SET status = 'active' WHERE status IS NULL OR status NOT IN ('active','disabled')");
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
    const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (!rows.some((row) => row.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

export function backupAdminSqlite(storagePath: string, destPath: string): void {
    const st = statSync(storagePath);
    if (!st.isFile()) {
        throw new Error(`admin SQLite database is not a file: ${storagePath}`);
    }
    mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 });
    rmSync(destPath, { force: true });
    const db = openAdminDatabase(storagePath);
    try {
        db.query("VACUUM INTO ?").run(destPath);
    } finally {
        db.close();
    }
    chmodSync(destPath, 0o600);
}
