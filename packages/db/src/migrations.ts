// SPDX-License-Identifier: AGPL-3.0-only

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_ACME_DIRECTORY,
  DEFAULT_DOH_RESOLVER,
  DEFAULT_REALITY_DEST_HOST,
  REQUIRED_SCHEMA_VERSION,
} from "@cool-tunnel/shared";

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
    // Lock down the DB and its WAL/SHM sidecars (which hold the same row data
    // pre-checkpoint) to 0600 rather than relying on the parent dir mode + the
    // ambient umask. Sidecars may not exist yet on a fresh DB — best effort.
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // Best effort for bind mounts and not-yet-created sidecars.
      }
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

-- Two-factor authentication (better-auth twoFactor plugin schema mirror).
-- Each row holds one user's TOTP secret + serialized backup codes.
-- 'verified' is true once the user has confirmed the first 6-digit code
-- during enrollment. Cascade deletes when the user is deleted.
-- See Learning:-14-better-auth for the enrollment + login flow.
CREATE TABLE IF NOT EXISTS twoFactor (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  backupCodes TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 1 CHECK (verified IN (0,1))
);
CREATE INDEX IF NOT EXISTS twoFactor_userId_idx ON twoFactor(userId);
CREATE INDEX IF NOT EXISTS twoFactor_secret_idx ON twoFactor(secret);
`);
  addColumnIfMissing(db, "user", "username", "TEXT");
  addColumnIfMissing(db, "user", "role", "TEXT NOT NULL DEFAULT 'viewer'");
  addColumnIfMissing(db, "user", "status", "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing(db, "user", "mustChangePassword", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "user", "lastLoginAt", "TEXT");
  addColumnIfMissing(db, "user", "disabledAt", "TEXT");
  addColumnIfMissing(db, "user", "twoFactorEnabled", "INTEGER NOT NULL DEFAULT 0");
  db.exec(
    "UPDATE user SET username = lower(substr(email, 1, instr(email || '@', '@') - 1)) WHERE username IS NULL OR username = ''",
  );
  db.exec(
    "UPDATE user SET role = 'viewer' WHERE role IS NULL OR role NOT IN ('owner','admin','operator','viewer')",
  );
  db.exec(
    "UPDATE user SET status = 'active' WHERE status IS NULL OR status NOT IN ('active','disabled')",
  );
  db.query(
    "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(REQUIRED_SCHEMA_VERSION));
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
