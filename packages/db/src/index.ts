// SPDX-License-Identifier: AGPL-3.0-only

import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type {
  AdminRole,
  AdminUser,
  AuditEntry,
  MigrationStatus,
  ProtocolKey,
  ProxyAccount,
  ProxyAccountSecretView,
  ServerSettings,
  StatusSummary,
  UserStatus,
} from "@cool-tunnel/shared";
import {
  DEFAULT_ACME_DIRECTORY,
  DEFAULT_DOH_RESOLVER,
  DEFAULT_PROTOCOL_KEYS,
  DEFAULT_REALITY_DEST_HOST,
  RELEASE_VERSION,
  REQUIRED_SCHEMA_VERSION,
  canManageTarget,
  requireRole,
} from "@cool-tunnel/shared";
import type { AdminConfig } from "@cool-tunnel/config";
import {
  auditDetail,
  constantTimeEqual,
  generateBootstrapToken,
  hashBootstrapToken,
  maskSubscriptionUrl,
  normalizeDomain,
  normalizeEmail,
  normalizeUsername,
  nowIso,
  randomId,
  randomToken,
  tokenFingerprint,
  validateId,
  validateName,
  validateUrl,
} from "@cool-tunnel/security";

export class StoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export interface AdminDb {
  db: Database;
  path: string;
}

export function openAdminDb(path: string): AdminDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort for bind mounts.
    }
  }
  return { db, path };
}

export function migrateAdminDb(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','admin','operator','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  mustChangePassword INTEGER NOT NULL DEFAULT 0 CHECK (mustChangePassword IN (0,1)),
  lastLoginAt TEXT,
  disabledAt TEXT
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_userId_idx ON session(userId);
CREATE INDEX IF NOT EXISTS session_expiresAt_idx ON session(expiresAt);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  password TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS account_userId_idx ON account(userId);

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
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
  expiresAt TEXT NOT NULL,
  usedAt TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bootstrap_token_expiresAt_idx ON bootstrap_token(expiresAt);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actorUserId TEXT,
  action TEXT NOT NULL,
  targetType TEXT,
  targetId TEXT,
  detail TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_createdAt_idx ON audit_log(createdAt);

CREATE TABLE IF NOT EXISTS server_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  domain TEXT NOT NULL,
  panelDomain TEXT NOT NULL,
  acmeEmail TEXT NOT NULL,
  acmeDirectory TEXT NOT NULL DEFAULT '${DEFAULT_ACME_DIRECTORY}',
  antiTrackingHideIp INTEGER NOT NULL DEFAULT 1,
  antiTrackingHideVia INTEGER NOT NULL DEFAULT 1,
  antiTrackingProbeResistance INTEGER NOT NULL DEFAULT 1,
  antiTrackingDohResolver TEXT NOT NULL DEFAULT '${DEFAULT_DOH_RESOLVER}',
  http3Enabled INTEGER NOT NULL DEFAULT 0,
  realityPrivateKey TEXT NOT NULL,
  realityPublicKey TEXT NOT NULL,
  realityDestHost TEXT NOT NULL DEFAULT '${DEFAULT_REALITY_DEST_HOST}',
  realityShortIds TEXT NOT NULL DEFAULT '[""]',
  lastCaddyfileHash TEXT,
  lastRenderedAt TEXT,
  selfProbeHistory TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxy_account (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  uuid TEXT NOT NULL UNIQUE,
  previousUuid TEXT,
  previousUuidValidUntil TEXT,
  subscriptionSecret TEXT UNIQUE,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  clientDefaultLocalPort INTEGER NOT NULL DEFAULT 1080,
  enabledProtocols TEXT NOT NULL DEFAULT '["vless_reality"]',
  expiresAt TEXT,
  lastSeenAt TEXT,
  metadata TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proxy_account_enabled_expires_idx ON proxy_account(enabled, expiresAt);
CREATE INDEX IF NOT EXISTS proxy_account_previous_uuid_idx ON proxy_account(previousUuidValidUntil);

CREATE TABLE IF NOT EXISTS fake_website (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  template TEXT NOT NULL DEFAULT 'blog' CHECK (template IN ('blog','corporate','portfolio')),
  title TEXT,
  tagline TEXT,
  payload TEXT,
  isActive INTEGER NOT NULL DEFAULT 0 CHECK (isActive IN (0,1)),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
  addColumnIfMissing(db, "user", "username", "TEXT");
  addColumnIfMissing(db, "user", "role", "TEXT NOT NULL DEFAULT 'viewer'");
  addColumnIfMissing(db, "user", "status", "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing(db, "user", "mustChangePassword", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "user", "lastLoginAt", "TEXT");
  addColumnIfMissing(db, "user", "disabledAt", "TEXT");
  db.exec("UPDATE user SET username = lower(substr(email, 1, instr(email || '@', '@') - 1)) WHERE username IS NULL OR username = ''");
  db.exec("UPDATE user SET role = 'viewer' WHERE role IS NULL OR role NOT IN ('owner','admin','operator','viewer')");
  db.exec("UPDATE user SET status = 'active' WHERE status IS NULL OR status NOT IN ('active','disabled')");
  migrateLegacyPhpData(db);
  db.query("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(REQUIRED_SCHEMA_VERSION));
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnNames(db: Database, table: string): Set<string> {
  return new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function migrateLegacyPhpData(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_php_migration (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      migratedAt TEXT NOT NULL,
      usersMigrated INTEGER NOT NULL DEFAULT 0,
      proxyAccountsMigrated INTEGER NOT NULL DEFAULT 0,
      settingsMigrated INTEGER NOT NULL DEFAULT 0,
      notes TEXT
    )
  `);
  const completed = db.query<{ id: number }, []>("SELECT id FROM legacy_php_migration WHERE id = 1").get();
  if (completed) return;
  const hasLegacyUsers = tableExists(db, "legacy_users");
  const hasLegacyProxyAccounts = tableExists(db, "legacy_proxy_accounts");
  const hasLegacyServerConfigs = tableExists(db, "legacy_server_configs");
  if (!hasLegacyUsers && !hasLegacyProxyAccounts && !hasLegacyServerConfigs) return;
  let usersMigrated = 0;
  let proxyAccountsMigrated = 0;
  let settingsMigrated = 0;
  const ts = nowIso();

  if (hasLegacyUsers) {
    const cols = columnNames(db, "legacy_users");
    const rows = db.query<Record<string, unknown>, []>("SELECT * FROM legacy_users").all();
    for (const row of rows) {
      const id = String(row.id ?? randomId());
      const email = String(row.email ?? "");
      if (!email.includes("@")) continue;
      const username = cols.has("username") && row.username ? String(row.username) : email.split("@")[0] ?? id;
      const roleRaw = String(row.role ?? "viewer");
      const role = roleRaw === "owner" || roleRaw === "admin" || roleRaw === "operator" || roleRaw === "viewer" ? roleRaw : "viewer";
      const status = row.is_active === 0 || row.is_active === false || row.status === "disabled" ? "disabled" : "active";
      db.query(`
        INSERT INTO user (
          id, name, email, emailVerified, image, createdAt, updatedAt, username, role, status, mustChangePassword, disabledAt
        ) VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          name = excluded.name,
          username = excluded.username,
          role = excluded.role,
          status = excluded.status,
          mustChangePassword = excluded.mustChangePassword,
          updatedAt = excluded.updatedAt
      `).run(
        id,
        String(row.name ?? username),
        email.toLowerCase(),
        String(row.created_at ?? ts),
        String(row.updated_at ?? ts),
        username,
        role,
        status,
        row.must_change_password === 1 || row.mustChangePassword === 1 ? 1 : 0,
        status === "disabled" ? String(row.disabled_at ?? ts) : null,
      );
      if (row.password || row.password_hash) {
        db.query(`
          INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
          VALUES (?, ?, 'credential', ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET password = excluded.password, updatedAt = excluded.updatedAt
        `).run(randomId(), id, id, String(row.password ?? row.password_hash), ts, ts);
      }
      usersMigrated += 1;
    }
  }

  if (hasLegacyProxyAccounts) {
    const rows = db.query<Record<string, unknown>, []>("SELECT * FROM legacy_proxy_accounts").all();
    for (const row of rows) {
      const id = String(row.id ?? randomId());
      const username = String(row.username ?? "");
      const uuid = String(row.uuid ?? "");
      if (!username || !uuid) continue;
      db.query(`
        INSERT INTO proxy_account (
          id, username, uuid, previousUuid, previousUuidValidUntil, subscriptionSecret, label, enabled,
          clientDefaultLocalPort, enabledProtocols, expiresAt, lastSeenAt, metadata, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          uuid = excluded.uuid,
          previousUuid = excluded.previousUuid,
          previousUuidValidUntil = excluded.previousUuidValidUntil,
          subscriptionSecret = COALESCE(proxy_account.subscriptionSecret, excluded.subscriptionSecret),
          label = excluded.label,
          enabled = excluded.enabled,
          clientDefaultLocalPort = excluded.clientDefaultLocalPort,
          enabledProtocols = excluded.enabledProtocols,
          expiresAt = excluded.expiresAt,
          updatedAt = excluded.updatedAt
      `).run(
        id,
        username,
        uuid,
        stringOrNull(row.previous_uuid ?? row.previousUuid),
        stringOrNull(row.previous_uuid_valid_until ?? row.previousUuidValidUntil),
        String(row.subscription_secret ?? row.subscriptionSecret ?? randomToken(32)),
        stringOrNull(row.label),
        row.enabled === 0 || row.enabled === false ? 0 : 1,
        Number(row.client_default_local_port ?? row.clientDefaultLocalPort ?? 1080),
        JSON.stringify(normalizeProtocols(row.enabled_protocols ?? row.enabledProtocols)),
        stringOrNull(row.expires_at ?? row.expiresAt),
        stringOrNull(row.last_seen_at ?? row.lastSeenAt),
        String(row.created_at ?? row.createdAt ?? ts),
        String(row.updated_at ?? row.updatedAt ?? ts),
      );
      proxyAccountsMigrated += 1;
    }
  }

  if (hasLegacyServerConfigs) {
    const row = db.query<Record<string, unknown>, []>("SELECT * FROM legacy_server_configs ORDER BY id LIMIT 1").get();
    if (row) {
      db.query(`
        INSERT INTO server_config (
          id, domain, panelDomain, acmeEmail, acmeDirectory,
          antiTrackingHideIp, antiTrackingHideVia, antiTrackingProbeResistance, antiTrackingDohResolver, http3Enabled,
          realityPrivateKey, realityPublicKey, realityDestHost, realityShortIds, lastCaddyfileHash, lastRenderedAt,
          createdAt, updatedAt
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          domain = excluded.domain,
          panelDomain = excluded.panelDomain,
          acmeEmail = excluded.acmeEmail,
          acmeDirectory = excluded.acmeDirectory,
          antiTrackingHideIp = excluded.antiTrackingHideIp,
          antiTrackingHideVia = excluded.antiTrackingHideVia,
          antiTrackingProbeResistance = excluded.antiTrackingProbeResistance,
          antiTrackingDohResolver = excluded.antiTrackingDohResolver,
          realityPrivateKey = COALESCE(NULLIF(server_config.realityPrivateKey, ''), excluded.realityPrivateKey),
          realityPublicKey = COALESCE(NULLIF(server_config.realityPublicKey, ''), excluded.realityPublicKey),
          realityDestHost = excluded.realityDestHost,
          realityShortIds = excluded.realityShortIds,
          lastCaddyfileHash = excluded.lastCaddyfileHash,
          lastRenderedAt = excluded.lastRenderedAt,
          updatedAt = excluded.updatedAt
      `).run(
        String(row.domain ?? "localhost.localdomain"),
        String(row.panel_domain ?? row.panelDomain ?? "panel.localhost.localdomain"),
        String(row.acme_email ?? row.acmeEmail ?? "admin@example.com"),
        String(row.acme_directory ?? row.acmeDirectory ?? DEFAULT_ACME_DIRECTORY),
        row.anti_tracking_hide_ip === 0 || row.antiTrackingHideIp === false ? 0 : 1,
        row.anti_tracking_hide_via === 0 || row.antiTrackingHideVia === false ? 0 : 1,
        row.anti_tracking_probe_resistance === 0 || row.antiTrackingProbeResistance === false ? 0 : 1,
        String(row.anti_tracking_doh_resolver ?? row.antiTrackingDohResolver ?? DEFAULT_DOH_RESOLVER),
        String(row.reality_private_key ?? row.realityPrivateKey ?? ""),
        String(row.reality_public_key ?? row.realityPublicKey ?? ""),
        String(row.reality_dest_host ?? row.realityDestHost ?? DEFAULT_REALITY_DEST_HOST),
        typeof row.reality_short_ids === "string" ? row.reality_short_ids : JSON.stringify(row.realityShortIds ?? [""]),
        stringOrNull(row.last_caddyfile_hash ?? row.lastCaddyfileHash),
        stringOrNull(row.last_rendered_at ?? row.lastRenderedAt),
        String(row.created_at ?? row.createdAt ?? ts),
        String(row.updated_at ?? row.updatedAt ?? ts),
      );
      settingsMigrated = 1;
    }
  }

  db.query(`
    INSERT INTO legacy_php_migration (id, migratedAt, usersMigrated, proxyAccountsMigrated, settingsMigrated, notes)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    ts,
    usersMigrated,
    proxyAccountsMigrated,
    settingsMigrated,
    "Imported from optional legacy_* staging tables. MariaDB exports must be staged explicitly before migration.",
  );
}

export function backupAdminSqlite(storagePath: string, destPath: string): void {
  const st = statSync(storagePath);
  if (!st.isFile()) throw new Error(`admin SQLite database is not a file: ${storagePath}`);
  mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 });
  rmSync(destPath, { force: true });
  const db = openAdminDb(storagePath).db;
  try {
    db.query("VACUUM INTO ?").run(destPath);
  } finally {
    db.close();
  }
  chmodSync(destPath, 0o600);
}

export interface CreateUserInput {
  email: string;
  username: string;
  name: string;
  passwordHash: string;
  role: AdminRole;
  mustChangePassword?: boolean;
}

export interface UpdateUserInput {
  email?: string;
  username?: string;
  name?: string;
  role?: AdminRole;
  status?: UserStatus;
  mustChangePassword?: boolean;
}

export interface CreateProxyAccountInput {
  username: string;
  label?: string | null;
  enabled?: boolean;
  clientDefaultLocalPort?: number;
  enabledProtocols?: ProtocolKey[];
  expiresAt?: string | null;
}

export interface UpdateProxyAccountInput extends Partial<CreateProxyAccountInput> {}

export class AdminStore {
  constructor(public readonly db: Database, public readonly config?: AdminConfig) {}

  ensureDefaults(config: AdminConfig = this.requireConfig()): void {
    const now = nowIso();
    this.db.query(`
      INSERT INTO server_config (
        id, domain, panelDomain, acmeEmail, acmeDirectory,
        antiTrackingHideIp, antiTrackingHideVia, antiTrackingProbeResistance,
        antiTrackingDohResolver, http3Enabled,
        realityPrivateKey, realityPublicKey, realityDestHost, realityShortIds,
        createdAt, updatedAt
      ) VALUES (1, ?, ?, ?, ?, 1, 1, 1, ?, 0, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        domain = excluded.domain,
        panelDomain = excluded.panelDomain,
        acmeEmail = excluded.acmeEmail,
        acmeDirectory = excluded.acmeDirectory,
        antiTrackingDohResolver = excluded.antiTrackingDohResolver,
        realityPrivateKey = COALESCE(NULLIF(server_config.realityPrivateKey, ''), excluded.realityPrivateKey),
        realityPublicKey = COALESCE(NULLIF(server_config.realityPublicKey, ''), excluded.realityPublicKey),
        realityDestHost = COALESCE(NULLIF(server_config.realityDestHost, ''), excluded.realityDestHost),
        realityShortIds = COALESCE(NULLIF(server_config.realityShortIds, ''), excluded.realityShortIds),
        updatedAt = excluded.updatedAt
    `).run(
      config.domain,
      config.panelDomain,
      config.acmeEmail,
      config.acmeDirectory,
      config.antiTrackingDohResolver,
      config.realityPrivateKey,
      config.realityPublicKey,
      config.realityDestHost,
      JSON.stringify(config.realityShortIds),
      now,
      now,
    );
  }

  ownerCount(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user WHERE role = 'owner' AND status = 'active'").get()?.n ?? 0;
  }

  hasOwner(): boolean {
    return this.ownerCount() > 0;
  }

  userCount(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user").get()?.n ?? 0;
  }

  listUsers(): AdminUser[] {
    return this.db.query<Record<string, unknown>, []>("SELECT * FROM user ORDER BY role = 'owner' DESC, createdAt DESC").all().map(rowToUser);
  }

  getUser(id: string): AdminUser | null {
    if (!validateId(id)) return null;
    const row = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM user WHERE id = ?").get(id);
    return row ? rowToUser(row) : null;
  }

  getUserByEmail(email: string): AdminUser | null {
    const normalized = normalizeEmail(email);
    const row = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM user WHERE email = ?").get(normalized);
    return row ? rowToUser(row) : null;
  }

  getUserByLogin(login: string): (AdminUser & { passwordHash: string }) | null {
    const trimmed = login.trim();
    const row = this.db.query<Record<string, unknown>, [string, string]>(
      `SELECT user.*, account.password AS password_hash
       FROM user JOIN account ON account.userId = user.id AND account.providerId = 'credential'
       WHERE user.email = ? OR user.username = ?`,
    ).get(trimmed.toLowerCase(), trimmed);
    if (!row) return null;
    return { ...rowToUser(row), passwordHash: String(row.password_hash ?? "") };
  }

  createUser(actor: AdminUser | null, input: CreateUserInput): AdminUser {
    return this.db.transaction(() => this.insertUser(actor, input))();
  }

  createFirstOwner(input: CreateUserInput, tokenHash: string): AdminUser {
    return this.db.transaction(() => {
      if (this.hasOwner()) throw new StoreError("bootstrap_disabled", "Bootstrap is disabled because an owner already exists.", 403);
      const token = this.consumeBootstrapTokenHash(tokenHash);
      if (!token.ok) throw new StoreError("invalid_bootstrap_token", bootstrapFailureMessage(token.reason), 403);
      if (input.role !== "owner") throw new StoreError("invalid_role", "First bootstrap user must be an owner.");
      const user = this.insertUser(null, input);
      this.audit(user.id, "bootstrap.owner.created", "user", user.id, { username: user.username });
      return user;
    })();
  }

  updateUser(actor: AdminUser, id: string, input: UpdateUserInput): AdminUser {
    const target = this.requireUser(id);
    if (!canManageTarget(actor, target)) throw new StoreError("forbidden", "You do not have permission to manage this user.", 403);
    const nextRole = input.role === undefined ? target.role : requireRole(input.role);
    const nextStatus = input.status ?? target.status;
    if (nextStatus !== "active" && nextStatus !== "disabled") throw new StoreError("invalid_status", "Choose a valid status.");
    if (nextRole === "owner" && actor.role !== "owner") throw new StoreError("forbidden", "Only owners can grant owner role.", 403);
    this.assertLastOwnerPreserved(target, nextRole, nextStatus);
    const email = input.email === undefined ? target.email : normalizeEmail(input.email);
    const username = input.username === undefined ? target.username : normalizeUsername(input.username);
    const name = input.name === undefined ? target.name : input.name.trim();
    if (!validateName(name)) throw new StoreError("invalid_name", "Name is required.");
    const ts = nowIso();
    try {
      this.db.query(`
        UPDATE user
        SET email = ?, username = ?, name = ?, role = ?, status = ?, mustChangePassword = ?,
            disabledAt = CASE WHEN ? = 'disabled' THEN COALESCE(disabledAt, ?) ELSE NULL END,
            updatedAt = ?
        WHERE id = ?
      `).run(
        email,
        username,
        name,
        nextRole,
        nextStatus,
        input.mustChangePassword === undefined ? (target.mustChangePassword ? 1 : 0) : (input.mustChangePassword ? 1 : 0),
        nextStatus,
        ts,
        ts,
        id,
      );
    } catch (e) {
      throw uniqueOrDatabaseError(e, "duplicate_user", "A user with that email or username already exists.");
    }
    if (nextStatus === "disabled") this.db.query("DELETE FROM session WHERE userId = ?").run(id);
    const updated = this.requireUser(id);
    this.audit(actor.id, "user.updated", "user", id, { role: updated.role, status: updated.status, changed: Object.keys(input).sort() });
    return updated;
  }

  disableUser(actor: AdminUser, id: string): AdminUser {
    return this.updateUser(actor, id, { status: "disabled" });
  }

  enableUser(actor: AdminUser, id: string): AdminUser {
    return this.updateUser(actor, id, { status: "active" });
  }

  resetPassword(actor: AdminUser, id: string, passwordHash: string): AdminUser {
    const target = this.requireUser(id);
    if (!canManageTarget(actor, target)) throw new StoreError("forbidden", "You do not have permission to reset this password.", 403);
    const ts = nowIso();
    this.db.query("UPDATE account SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = 'credential'").run(passwordHash, ts, id);
    this.db.query("UPDATE user SET mustChangePassword = 1, updatedAt = ? WHERE id = ?").run(ts, id);
    this.db.query("DELETE FROM session WHERE userId = ?").run(id);
    const updated = this.requireUser(id);
    this.audit(actor.id, "user.password_reset", "user", id, {});
    return updated;
  }

  deleteUser(actor: AdminUser, id: string): void {
    const target = this.requireUser(id);
    if (actor.id === target.id) throw new StoreError("cannot_delete_self", "You cannot delete your own account.");
    if (actor.role !== "owner") throw new StoreError("forbidden", "Only owners can delete users.", 403);
    this.assertLastOwnerPreserved(target, "__deleted__" as AdminRole, "disabled");
    this.db.query("DELETE FROM user WHERE id = ?").run(id);
    this.audit(actor.id, "user.deleted", "user", id, { targetRole: target.role, targetUsername: target.username });
  }

  markLogin(userId: string): void {
    const ts = nowIso();
    this.db.query("UPDATE user SET lastLoginAt = ?, updatedAt = ? WHERE id = ?").run(ts, ts, userId);
    this.audit(userId, "auth.login", "user", userId, {});
  }

  async createBootstrapToken(config: Pick<AdminConfig, "authSecret">, ttlMinutes = 15): Promise<{ token: string; expiresAt: string; pathHint: string }> {
    if (this.hasOwner()) throw new StoreError("bootstrap_disabled", "Bootstrap is disabled because an owner already exists.", 403);
    this.pruneExpiredBootstrapTokens();
    const token = generateBootstrapToken();
    const tokenHash = await hashBootstrapToken(token, config.authSecret);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    this.db.query("INSERT INTO bootstrap_token (id, tokenHash, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, NULL, ?)").run(
      randomId(),
      tokenHash,
      expiresAt,
      nowIso(),
    );
    this.audit(null, "bootstrap.token.created", "bootstrap_token", null, { tokenFingerprint: tokenFingerprint(token), expiresAt });
    return { token, expiresAt, pathHint: "/setup?token=<redacted>" };
  }

  consumeBootstrapTokenHash(tokenHash: string): { ok: true; tokenId: string } | { ok: false; reason: "missing" | "used" | "expired" } {
    const row = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM bootstrap_token WHERE tokenHash = ?").get(tokenHash);
    if (!row) return { ok: false, reason: "missing" };
    if (row.usedAt !== null) return { ok: false, reason: "used" };
    if (Date.parse(String(row.expiresAt)) <= Date.now()) return { ok: false, reason: "expired" };
    this.db.query("UPDATE bootstrap_token SET usedAt = ? WHERE id = ? AND usedAt IS NULL").run(nowIso(), String(row.id));
    return { ok: true, tokenId: String(row.id) };
  }

  pruneExpiredBootstrapTokens(): void {
    this.db.query("DELETE FROM bootstrap_token WHERE expiresAt <= ? OR usedAt IS NOT NULL").run(nowIso());
  }

  listProxyAccounts(): ProxyAccount[] {
    return this.db.query<Record<string, unknown>, []>("SELECT * FROM proxy_account ORDER BY createdAt DESC").all().map((row) => rowToProxyAccount(row, this.panelDomain(), this.config?.authSecret ?? ""));
  }

  getProxyAccount(id: string): ProxyAccountSecretView | null {
    if (!validateId(id)) return null;
    const row = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM proxy_account WHERE id = ?").get(id);
    return row ? rowToProxyAccountSecret(row, this.panelDomain(), this.config?.authSecret ?? "") : null;
  }

  createProxyAccount(actor: AdminUser, input: CreateProxyAccountInput): ProxyAccountSecretView {
    const id = randomId();
    const uuid = crypto.randomUUID();
    const subscriptionSecret = randomToken(32);
    const ts = nowIso();
    const normalized = normalizeProxyInput(input);
    this.db.query(`
      INSERT INTO proxy_account (
        id, username, uuid, previousUuid, previousUuidValidUntil, subscriptionSecret, label, enabled,
        clientDefaultLocalPort, enabledProtocols, expiresAt, lastSeenAt, metadata, createdAt, updatedAt
      ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      id,
      normalized.username,
      uuid,
      subscriptionSecret,
      normalized.label,
      normalized.enabled ? 1 : 0,
      normalized.clientDefaultLocalPort,
      JSON.stringify(normalized.enabledProtocols),
      normalized.expiresAt,
      ts,
      ts,
    );
    const created = this.getProxyAccount(id);
    if (!created) throw new StoreError("database_error", "Proxy account creation failed.", 500);
    this.audit(actor.id, "proxy_account.created", "proxy_account", id, { username: created.username, status: created.status });
    return created;
  }

  updateProxyAccount(actor: AdminUser, id: string, input: UpdateProxyAccountInput): ProxyAccount {
    const current = this.getProxyAccount(id);
    if (!current) throw new StoreError("not_found", "Proxy account not found.", 404);
    const normalized = normalizeProxyInput({
      username: input.username ?? current.username,
      label: input.label === undefined ? current.label : input.label,
      enabled: input.enabled ?? current.enabled,
      clientDefaultLocalPort: input.clientDefaultLocalPort ?? current.clientDefaultLocalPort,
      enabledProtocols: input.enabledProtocols ?? current.enabledProtocols,
      expiresAt: input.expiresAt === undefined ? current.expiresAt : input.expiresAt,
    });
    const ts = nowIso();
    this.db.query(`
      UPDATE proxy_account
      SET username = ?, label = ?, enabled = ?, clientDefaultLocalPort = ?, enabledProtocols = ?, expiresAt = ?, updatedAt = ?
      WHERE id = ?
    `).run(
      normalized.username,
      normalized.label,
      normalized.enabled ? 1 : 0,
      normalized.clientDefaultLocalPort,
      JSON.stringify(normalized.enabledProtocols),
      normalized.expiresAt,
      ts,
      id,
    );
    const updated = this.getProxyAccount(id);
    if (!updated) throw new StoreError("not_found", "Proxy account not found.", 404);
    this.audit(actor.id, "proxy_account.updated", "proxy_account", id, { username: updated.username, changed: Object.keys(input).sort() });
    return updated;
  }

  setProxyEnabled(actor: AdminUser, id: string, enabled: boolean): ProxyAccount {
    return this.updateProxyAccount(actor, id, { enabled });
  }

  regenerateProxyUuid(actor: AdminUser, id: string): ProxyAccountSecretView {
    const current = this.getProxyAccount(id);
    if (!current) throw new StoreError("not_found", "Proxy account not found.", 404);
    const uuid = crypto.randomUUID();
    const secret = randomToken(32);
    const ts = nowIso();
    const previousValidUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    this.db.query(`
      UPDATE proxy_account
      SET uuid = ?, previousUuid = ?, previousUuidValidUntil = ?, subscriptionSecret = ?, updatedAt = ?
      WHERE id = ?
    `).run(uuid, current.uuid, previousValidUntil, secret, ts, id);
    const updated = this.getProxyAccount(id);
    if (!updated) throw new StoreError("not_found", "Proxy account not found.", 404);
    this.audit(actor.id, "proxy_account.uuid_rotated", "proxy_account", id, { username: updated.username, previousUuidValidUntil: previousValidUntil });
    return updated;
  }

  deleteProxyAccount(actor: AdminUser, id: string): void {
    const current = this.getProxyAccount(id);
    if (!current) throw new StoreError("not_found", "Proxy account not found.", 404);
    this.db.query("DELETE FROM proxy_account WHERE id = ?").run(id);
    this.audit(actor.id, "proxy_account.deleted", "proxy_account", id, { username: current.username });
  }

  getSettings(): ServerSettings {
    const existing = this.db.query<Record<string, unknown>, []>("SELECT * FROM server_config WHERE id = 1").get();
    if (existing) return rowToSettings(existing);
    this.ensureDefaults();
    const row = this.db.query<Record<string, unknown>, []>("SELECT * FROM server_config WHERE id = 1").get();
    if (!row) throw new StoreError("settings_missing", "Server settings are missing.", 500);
    return rowToSettings(row);
  }

  updateSettings(actor: AdminUser, input: Partial<ServerSettings>): ServerSettings {
    const current = this.getSettings();
    let next: {
      domain: string;
      panelDomain: string;
      acmeEmail: string;
      acmeDirectory: string;
      antiTrackingHideIp: boolean;
      antiTrackingHideVia: boolean;
      antiTrackingProbeResistance: boolean;
      antiTrackingDohResolver: string;
      http3Enabled: false;
      realityDestHost: string;
      realityShortIds: string[];
    };
    try {
      next = {
        domain: input.domain === undefined ? current.domain : normalizeDomain(input.domain, "DOMAIN"),
        panelDomain: input.panelDomain === undefined ? current.panelDomain : normalizeDomain(input.panelDomain, "PANEL_DOMAIN"),
        acmeEmail: input.acmeEmail === undefined ? current.acmeEmail : normalizeEmail(input.acmeEmail),
        acmeDirectory: input.acmeDirectory ?? current.acmeDirectory,
        antiTrackingHideIp: input.antiTrackingHideIp ?? current.antiTrackingHideIp,
        antiTrackingHideVia: input.antiTrackingHideVia ?? current.antiTrackingHideVia,
        antiTrackingProbeResistance: input.antiTrackingProbeResistance ?? current.antiTrackingProbeResistance,
        antiTrackingDohResolver: input.antiTrackingDohResolver ?? current.antiTrackingDohResolver,
        http3Enabled: false,
        realityDestHost: input.realityDestHost === undefined ? current.realityDestHost : normalizeDomain(input.realityDestHost, "REALITY_DEST_HOST"),
        realityShortIds: input.realityShortIds ?? current.realityShortIds,
      };
    } catch (error) {
      throw new StoreError("invalid_settings", error instanceof Error ? error.message : "Settings validation failed.");
    }
    if (!validateUrl(next.acmeDirectory, ["https:"])) throw new StoreError("invalid_acme_directory", "ACME directory must be an https URL.");
    if (!validateUrl(next.antiTrackingDohResolver, ["https:"])) throw new StoreError("invalid_doh_resolver", "DoH resolver must be an https URL.");
    const ts = nowIso();
    this.db.query(`
      UPDATE server_config
      SET domain = ?, panelDomain = ?, acmeEmail = ?, acmeDirectory = ?,
          antiTrackingHideIp = ?, antiTrackingHideVia = ?, antiTrackingProbeResistance = ?,
          antiTrackingDohResolver = ?, http3Enabled = ?, realityDestHost = ?, realityShortIds = ?, updatedAt = ?
      WHERE id = 1
    `).run(
      next.domain,
      next.panelDomain,
      next.acmeEmail,
      next.acmeDirectory,
      next.antiTrackingHideIp ? 1 : 0,
      next.antiTrackingHideVia ? 1 : 0,
      next.antiTrackingProbeResistance ? 1 : 0,
      next.antiTrackingDohResolver,
      0,
      next.realityDestHost,
      JSON.stringify(next.realityShortIds),
      ts,
    );
    const updated = this.getSettings();
    this.audit(actor.id, "settings.updated", "server_config", "1", { changed: Object.keys(input).sort() });
    return updated;
  }

  listAudit(limit = 100): AuditEntry[] {
    const bounded = Math.max(1, Math.min(250, Math.floor(limit)));
    return this.db.query<Record<string, unknown>, [number]>("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(bounded).map(rowToAudit);
  }

  audit(actorUserId: string | null, action: string, targetType: string | null, targetId: string | null, detail: Record<string, unknown>): void {
    this.db.query("INSERT INTO audit_log (action, actorUserId, targetType, targetId, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?)").run(
      action,
      actorUserId,
      targetType,
      targetId,
      auditDetail(detail),
      nowIso(),
    );
  }

  migrationStatus(): MigrationStatus {
    const row = this.db.query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    const currentVersion = Number(row?.value ?? "0");
    const legacyDetected = tableExists(this.db, "legacy_users")
      || tableExists(this.db, "legacy_proxy_accounts")
      || tableExists(this.db, "legacy_server_configs");
    const legacyMigrated = Boolean(this.db.query<{ id: number }, []>("SELECT id FROM legacy_php_migration WHERE id = 1").get());
    return {
      currentVersion,
      requiredVersion: REQUIRED_SCHEMA_VERSION,
      ok: currentVersion >= REQUIRED_SCHEMA_VERSION,
      legacyPhpDetected: legacyDetected && !legacyMigrated,
      legacyMigrationAvailable: true,
      message: currentVersion >= REQUIRED_SCHEMA_VERSION
        ? legacyDetected && !legacyMigrated
          ? "SQLite schema is current; legacy PHP staging tables are present and need `ct admin migrate`."
          : "SQLite schema is current."
        : "Run `ct admin migrate` before starting the admin runtime.",
    };
  }

  statusSummary(): StatusSummary {
    const accounts = this.listProxyAccounts();
    const settings = this.getSettings();
    return {
      version: RELEASE_VERSION,
      hasOwner: this.hasOwner(),
      userCount: this.userCount(),
      proxyAccountCount: accounts.length,
      activeProxyAccountCount: accounts.filter((account) => account.status === "active").length,
      settingsReady: settings.domain !== "" && settings.realityPublicKey !== "",
      migration: this.migrationStatus(),
      services: [
        { name: "api", status: "running", detail: "Hono admin API is responding." },
        { name: "sqlite", status: "running", detail: "SQLite database opened with migrations applied." },
        { name: "rust-core", status: "unknown", detail: "Run doctor for Rust/core process checks." },
        { name: "singbox", status: "unknown", detail: "Run doctor for sing-box runtime checks." },
        { name: "caddy", status: "unknown", detail: "Run doctor for Caddy runtime checks." },
      ],
    };
  }

  subscriptionToken(account: { id: string; subscriptionSecret: string | null }, secret = this.config?.authSecret ?? ""): string | null {
    if (!secret) return null;
    const signed = account.subscriptionSecret ? `${account.id}.${account.subscriptionSecret}` : account.id;
    const sig = createHmac("sha256", secret).update(signed).digest("hex");
    return Buffer.from(`${account.id}.${sig}`).toString("base64url");
  }

  async subscriptionTokenStrong(account: { id: string; subscriptionSecret: string | null }, secret = this.config?.authSecret ?? ""): Promise<string | null> {
    return this.subscriptionToken(account, secret);
  }

  async resolveSubscriptionToken(token: string): Promise<Record<string, unknown> | null> {
    let decoded = "";
    try {
      decoded = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    } catch {
      return null;
    }
    if (!decoded.includes(".") || !this.config?.authSecret) return null;
    const [id, sig] = decoded.split(".", 2);
    if (!validateId(id)) return null;
    const row = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM proxy_account WHERE id = ?").get(id);
    if (!row) return null;
    const secret = String(row.subscriptionSecret ?? "");
    const signed = secret ? `${id}.${secret}` : id;
    const expected = createHmac("sha256", this.config.authSecret).update(signed).digest("hex");
    if (!constantTimeEqual(expected, sig ?? "")) return null;
    return row;
  }

  private panelDomain(): string {
    return this.getSettings().panelDomain;
  }

  private requireConfig(): AdminConfig {
    if (!this.config) throw new StoreError("config_required", "Admin config is required for this operation.", 500);
    return this.config;
  }

  private requireUser(id: string): AdminUser {
    const user = this.getUser(id);
    if (!user) throw new StoreError("not_found", "User not found.", 404);
    return user;
  }

  private insertUser(actor: AdminUser | null, input: CreateUserInput): AdminUser {
    const email = normalizeEmail(input.email);
    const username = normalizeUsername(input.username || email.split("@")[0] || "");
    const name = input.name.trim();
    if (!validateName(name)) throw new StoreError("invalid_name", "Name is required.");
    const role = requireRole(input.role);
    if (actor && role === "owner" && actor.role !== "owner") throw new StoreError("forbidden", "Only owners can create owner accounts.", 403);
    const id = randomId();
    const ts = nowIso();
    try {
      this.db.query(`
        INSERT INTO user (
          id, name, email, emailVerified, image, createdAt, updatedAt, username, role, status, mustChangePassword
        ) VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?, 'active', ?)
      `).run(id, name, email, ts, ts, username, role, input.mustChangePassword === true ? 1 : 0);
      this.db.query(`
        INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
        VALUES (?, ?, 'credential', ?, ?, ?, ?)
      `).run(randomId(), id, id, input.passwordHash, ts, ts);
    } catch (e) {
      throw uniqueOrDatabaseError(e, "duplicate_user", "A user with that email or username already exists.");
    }
    const user = this.requireUser(id);
    this.audit(actor?.id ?? null, "user.created", "user", user.id, { username: user.username, role: user.role });
    return user;
  }

  private assertLastOwnerPreserved(target: AdminUser, nextRole: AdminRole, nextStatus: UserStatus): void {
    if (target.role !== "owner" || target.status !== "active") return;
    if (nextRole === "owner" && nextStatus === "active") return;
    if (this.ownerCount() <= 1) throw new StoreError("last_owner", "You cannot remove, disable, or demote the last active owner.");
  }
}

function uniqueOrDatabaseError(e: unknown, code: string, message: string): StoreError {
  const msg = String(e instanceof Error ? e.message : e);
  if (msg.includes("UNIQUE")) return new StoreError(code, message, 409);
  return new StoreError("database_error", "The account database rejected the change.", 500);
}

function bootstrapFailureMessage(reason: "missing" | "used" | "expired"): string {
  switch (reason) {
    case "missing": return "Bootstrap token is invalid or expired.";
    case "used": return "Bootstrap token has already been used.";
    case "expired": return "Bootstrap token is invalid or expired.";
  }
}

function rowToUser(row: Record<string, unknown>): AdminUser {
  return {
    id: String(row.id),
    email: String(row.email),
    username: String(row.username ?? ""),
    name: String(row.name),
    role: requireRole(row.role),
    status: row.status === "disabled" ? "disabled" : "active",
    mustChangePassword: Number(row.mustChangePassword ?? 0) === 1,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    lastLoginAt: row.lastLoginAt === null || row.lastLoginAt === undefined ? null : String(row.lastLoginAt),
    disabledAt: row.disabledAt === null || row.disabledAt === undefined ? null : String(row.disabledAt),
  };
}

function normalizeProtocols(value: unknown): ProtocolKey[] {
  let raw: unknown = value;
  const rawString = raw;
  if (typeof rawString === "string") {
    try {
      raw = JSON.parse(rawString) as unknown;
    } catch {
      raw = rawString.split(",");
    }
  }
  if (!Array.isArray(raw)) return [...DEFAULT_PROTOCOL_KEYS];
  const protocols = raw.filter((item): item is ProtocolKey => item === "vless_reality");
  return protocols.length > 0 ? protocols : [...DEFAULT_PROTOCOL_KEYS];
}

function rowToProxyAccount(row: Record<string, unknown>, panelDomain: string, secret: string): ProxyAccount {
  const enabled = Number(row.enabled ?? 0) === 1;
  const expiresAt = row.expiresAt === null || row.expiresAt === undefined ? null : String(row.expiresAt);
  const expired = expiresAt !== null && Date.parse(expiresAt) <= Date.now();
  const subscriptionUrl = subscriptionUrlFor(row, panelDomain, secret);
  return {
    id: String(row.id),
    username: String(row.username),
    label: row.label === null || row.label === undefined ? null : String(row.label),
    status: !enabled ? "disabled" : expired ? "expired" : "active",
    enabled,
    clientDefaultLocalPort: Number(row.clientDefaultLocalPort ?? 1080),
    enabledProtocols: normalizeProtocols(row.enabledProtocols),
    expiresAt,
    lastSeenAt: row.lastSeenAt === null || row.lastSeenAt === undefined ? null : String(row.lastSeenAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    previousUuidValidUntil: row.previousUuidValidUntil === null || row.previousUuidValidUntil === undefined ? null : String(row.previousUuidValidUntil),
    subscriptionUrlMasked: maskSubscriptionUrl(subscriptionUrl),
  };
}

function rowToProxyAccountSecret(row: Record<string, unknown>, panelDomain: string, secret: string): ProxyAccountSecretView {
  return {
    ...rowToProxyAccount(row, panelDomain, secret),
    uuid: String(row.uuid),
    subscriptionUrl: subscriptionUrlFor(row, panelDomain, secret),
  };
}

function subscriptionUrlFor(row: Record<string, unknown>, panelDomain: string, secret: string): string | null {
  const id = String(row.id ?? "");
  if (!id || !secret) return null;
  const subscriptionSecret = row.subscriptionSecret === null || row.subscriptionSecret === undefined ? null : String(row.subscriptionSecret);
  const signed = subscriptionSecret ? `${id}.${subscriptionSecret}` : id;
  const sig = createHmac("sha256", secret).update(signed).digest("hex");
  const token = Buffer.from(`${id}.${sig}`).toString("base64url");
  if (!token) return null;
  return `https://${panelDomain}/api/v1/subscription/${token}`;
}

function normalizeProxyInput(input: CreateProxyAccountInput): Required<CreateProxyAccountInput> {
  const username = normalizeUsername(input.username);
  const label = input.label === undefined || input.label === null || input.label.trim() === "" ? null : input.label.trim();
  const enabled = input.enabled ?? true;
  const clientDefaultLocalPort = input.clientDefaultLocalPort ?? 1080;
  if (!Number.isInteger(clientDefaultLocalPort) || clientDefaultLocalPort < 1024 || clientDefaultLocalPort > 65535) {
    throw new StoreError("invalid_port", "Local SOCKS port must be 1024-65535.");
  }
  let expiresAt: string | null = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== "") {
    const parsed = Date.parse(input.expiresAt);
    if (Number.isNaN(parsed)) throw new StoreError("invalid_expires_at", "Expiry must be a valid date.");
    expiresAt = new Date(parsed).toISOString();
  }
  return {
    username,
    label,
    enabled,
    clientDefaultLocalPort,
    enabledProtocols: input.enabledProtocols?.filter((p): p is ProtocolKey => p === "vless_reality") ?? [...DEFAULT_PROTOCOL_KEYS],
    expiresAt,
  };
}

function rowToSettings(row: Record<string, unknown>): ServerSettings {
  return {
    domain: String(row.domain),
    panelDomain: String(row.panelDomain),
    acmeEmail: String(row.acmeEmail),
    acmeDirectory: String(row.acmeDirectory),
    antiTrackingHideIp: Number(row.antiTrackingHideIp) === 1,
    antiTrackingHideVia: Number(row.antiTrackingHideVia) === 1,
    antiTrackingProbeResistance: Number(row.antiTrackingProbeResistance) === 1,
    antiTrackingDohResolver: String(row.antiTrackingDohResolver),
    http3Enabled: false,
    realityPublicKey: String(row.realityPublicKey),
    realityDestHost: String(row.realityDestHost),
    realityShortIds: normalizeJsonStringList(row.realityShortIds),
    lastCaddyfileHash: row.lastCaddyfileHash === null || row.lastCaddyfileHash === undefined ? null : String(row.lastCaddyfileHash),
    lastRenderedAt: row.lastRenderedAt === null || row.lastRenderedAt === undefined ? null : String(row.lastRenderedAt),
    updatedAt: String(row.updatedAt),
  };
}

function normalizeJsonStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return value.split(",").map((part) => part.trim());
    }
  }
  return [""];
}

function rowToAudit(row: Record<string, unknown>): AuditEntry {
  return {
    id: Number(row.id),
    action: String(row.action),
    actorUserId: row.actorUserId === null || row.actorUserId === undefined ? null : String(row.actorUserId),
    targetType: row.targetType === null || row.targetType === undefined ? null : String(row.targetType),
    targetId: row.targetId === null || row.targetId === undefined ? null : String(row.targetId),
    detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
    createdAt: String(row.createdAt),
  };
}
