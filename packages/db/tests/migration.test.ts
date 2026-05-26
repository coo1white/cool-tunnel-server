// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "bun:test";
import { AdminStore, migrateAdminDb, openAdminDb } from "../src/index";
import { REQUIRED_SCHEMA_VERSION } from "@cool-tunnel/shared";

test("SQLite migrations are idempotent and record schema version", () => {
  const { db } = openAdminDb(":memory:");
  migrateAdminDb(db);
  migrateAdminDb(db);
  const store = new AdminStore(db);
  expect(store.migrationStatus()).toMatchObject({ ok: true, currentVersion: REQUIRED_SCHEMA_VERSION });
  expect(db.query("SELECT id FROM legacy_php_migration WHERE id = 1").get()).toBeNull();
});

test("legacy PHP migration marker is not burned before staging tables exist", () => {
  const { db } = openAdminDb(":memory:");
  migrateAdminDb(db);
  db.exec(`
    CREATE TABLE legacy_users (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      username TEXT,
      role TEXT,
      is_active INTEGER,
      must_change_password INTEGER,
      password TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  db.query("INSERT INTO legacy_users VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "late-owner",
    "Owner",
    "late-owner@example.com",
    "late-owner",
    "owner",
    1,
    0,
    "legacy-hash",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  const before = new AdminStore(db).migrationStatus();
  expect(before.legacyPhpDetected).toBe(true);
  migrateAdminDb(db);
  expect(new AdminStore(db).getUser("late-owner")?.role).toBe("owner");
  expect(db.query("SELECT id FROM legacy_php_migration WHERE id = 1").get()).not.toBeNull();
});

test("proxy account UUID rotates with previous UUID grace", () => {
  const { db } = openAdminDb(":memory:");
  migrateAdminDb(db);
  const store = new AdminStore(db, {
    appEnv: "test",
    host: "127.0.0.1",
    port: 9000,
    panelDomain: "panel.example.com",
    domain: "proxy.example.com",
    baseUrl: "http://localhost:9000",
    trustedOrigins: ["http://localhost:9000"],
    authSecret: "x".repeat(40),
    dbPath: ":memory:",
    publicSignup: false,
    secureCookies: false,
    bootstrapTokenTtlMinutes: 15,
    coreSocket: "/tmp/core.sock",
    caddyfilePath: "/tmp/Caddyfile",
    caddyfileTemplate: "/tmp/Caddyfile.tpl",
    singboxConfigPath: "/tmp/singbox.json",
    manifestsDir: "/tmp/manifests",
    acmeEmail: "ops@example.com",
    acmeDirectory: "https://acme-v02.api.letsencrypt.org/directory",
    realityPrivateKey: "A".repeat(43),
    realityPublicKey: "B".repeat(43),
    realityDestHost: "www.microsoft.com",
    realityShortIds: [""],
    antiTrackingDohResolver: "https://dns.alidns.com/dns-query",
    version: "0.5.3",
  });
  store.ensureDefaults();
  const actor = store.createUser(null, {
    email: "owner@example.com",
    username: "owner",
    name: "Owner",
    passwordHash: "hash",
    role: "owner",
  });
  const account = store.createProxyAccount(actor, { username: "alice" });
  const rotated = store.regenerateProxyUuid(actor, account.id);
  expect(rotated.uuid).not.toBe(account.uuid);
  expect(rotated.previousUuidValidUntil).toBeTruthy();
});

test("audit details minimize personal and secret fields", () => {
  const { db } = openAdminDb(":memory:");
  migrateAdminDb(db);
  const store = new AdminStore(db);
  const owner = store.createUser(null, {
    email: "owner@example.com",
    username: "owner",
    name: "Owner",
    passwordHash: "hash",
    role: "owner",
  });
  const target = store.createUser(owner, {
    email: "delete-me@example.com",
    username: "delete-me",
    name: "Delete Me",
    passwordHash: "hash",
    role: "viewer",
  });
  store.deleteUser(owner, target.id);
  const audit = store.listAudit(10).map((entry) => entry.detail ?? "").join("\n");
  expect(audit).not.toContain("owner@example.com");
  expect(audit).not.toContain("delete-me@example.com");
  expect(audit).not.toContain("hash");
  expect(audit).toContain("targetUsername");
});

test("legacy PHP staging migration is idempotent and preserves users accounts and settings", () => {
  const { db } = openAdminDb(":memory:");
  db.exec(`
    CREATE TABLE legacy_users (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      username TEXT,
      role TEXT,
      is_active INTEGER,
      must_change_password INTEGER,
      password TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE legacy_proxy_accounts (
      id TEXT PRIMARY KEY,
      username TEXT,
      uuid TEXT,
      previous_uuid TEXT,
      previous_uuid_valid_until TEXT,
      subscription_secret TEXT,
      label TEXT,
      enabled INTEGER,
      client_default_local_port INTEGER,
      enabled_protocols TEXT,
      expires_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE legacy_server_configs (
      id INTEGER PRIMARY KEY,
      domain TEXT,
      panel_domain TEXT,
      acme_email TEXT,
      acme_directory TEXT,
      anti_tracking_hide_ip INTEGER,
      anti_tracking_hide_via INTEGER,
      anti_tracking_probe_resistance INTEGER,
      anti_tracking_doh_resolver TEXT,
      reality_private_key TEXT,
      reality_public_key TEXT,
      reality_dest_host TEXT,
      reality_short_ids TEXT,
      last_caddyfile_hash TEXT,
      last_rendered_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  db.query("INSERT INTO legacy_users VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "legacy-owner",
    "Owner",
    "owner@example.com",
    "owner",
    "owner",
    1,
    1,
    "legacy-hash",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  db.query("INSERT INTO legacy_proxy_accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "legacy-proxy",
    "alice",
    "123e4567-e89b-12d3-a456-426614174000",
    "123e4567-e89b-12d3-a456-426614174001",
    "2026-01-01T00:10:00.000Z",
    "sub-secret",
    "Alice",
    1,
    1088,
    "[\"vless_reality\"]",
    null,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  db.query("INSERT INTO legacy_server_configs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    1,
    "proxy.example.com",
    "panel.example.com",
    "ops@example.com",
    "https://acme-v02.api.letsencrypt.org/directory",
    1,
    1,
    1,
    "https://dns.alidns.com/dns-query",
    "A".repeat(43),
    "B".repeat(43),
    "www.microsoft.com",
    "[\"\"]",
    "hash",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );

  migrateAdminDb(db);
  migrateAdminDb(db);
  const store = new AdminStore(db);
  expect(store.getUser("legacy-owner")?.role).toBe("owner");
  expect(store.getProxyAccount("legacy-proxy")?.username).toBe("alice");
  expect(store.getSettings().panelDomain).toBe("panel.example.com");
  const summary = db.query<{ usersMigrated: number; proxyAccountsMigrated: number; settingsMigrated: number }, []>(
    "SELECT usersMigrated, proxyAccountsMigrated, settingsMigrated FROM legacy_php_migration WHERE id = 1",
  ).get();
  expect(summary).toEqual({ usersMigrated: 1, proxyAccountsMigrated: 1, settingsMigrated: 1 });
});
