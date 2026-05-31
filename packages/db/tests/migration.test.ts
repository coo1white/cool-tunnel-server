// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "bun:test";
import { REQUIRED_SCHEMA_VERSION } from "@cool-tunnel/shared";
import { AdminStore, migrateAdminDb, openAdminDb } from "../src/index";

test("SQLite migrations are idempotent and record schema version", () => {
  const { db } = openAdminDb(":memory:");
  migrateAdminDb(db);
  migrateAdminDb(db);
  const store = new AdminStore(db);
  expect(store.migrationStatus()).toMatchObject({
    ok: true,
    currentVersion: REQUIRED_SCHEMA_VERSION,
  });
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
    version: "0.6.4",
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
  const audit = store
    .listAudit(10)
    .map((entry) => entry.detail ?? "")
    .join("\n");
  expect(audit).not.toContain("owner@example.com");
  expect(audit).not.toContain("delete-me@example.com");
  expect(audit).not.toContain("hash");
  expect(audit).toContain("targetUsername");
});

test("twoFactor schema (better-auth 2FA plugin) is migrated", () => {
  const { db } = openAdminDb(":memory:");
  migrateAdminDb(db);

  // user.twoFactorEnabled column exists with 0 default
  const userCols = db
    .query<{ name: string; dflt_value: string | null }, []>("PRAGMA table_info(user)")
    .all();
  const twoFaCol = userCols.find((c) => c.name === "twoFactorEnabled");
  expect(twoFaCol).toBeDefined();
  expect(twoFaCol?.dflt_value).toBe("0");

  // twoFactor table exists with all 5 expected columns
  const tfCols = db
    .query<{ name: string }, []>("PRAGMA table_info(twoFactor)")
    .all()
    .map((c) => c.name)
    .sort();
  expect(tfCols).toEqual(["backupCodes", "id", "secret", "userId", "verified"]);

  // FK + indexes registered
  const indexes = db
    .query<{ name: string }, []>("PRAGMA index_list(twoFactor)")
    .all()
    .map((i) => i.name);
  expect(indexes).toContain("twoFactor_userId_idx");
  expect(indexes).toContain("twoFactor_secret_idx");
});
