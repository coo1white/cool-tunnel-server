// SPDX-License-Identifier: AGPL-3.0-only

import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { DEFAULT_ACME_DIRECTORY, DEFAULT_DOH_RESOLVER, DEFAULT_REALITY_DEST_HOST, REQUIRED_SCHEMA_VERSION } from "@cool-tunnel/shared";
import { nowIso, randomId, randomToken } from "@cool-tunnel/security";
import { normalizeProtocols, stringOrNull, tableExists } from "./helpers.ts";

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
