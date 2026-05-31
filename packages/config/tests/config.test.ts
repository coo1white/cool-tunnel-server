// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "bun:test";
import { loadAdminConfig } from "../src/index";

const SECRET = "test-better-auth-secret-".padEnd(43, "x");

test("production requires https when secure cookies are enabled", () => {
  expect(() =>
    loadAdminConfig({
      APP_ENV: "production",
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "http://panel.example.com",
      DOMAIN: "proxy.example.com",
      PANEL_DOMAIN: "panel.example.com",
    }),
  ).toThrow("https://");
});

test("production rejects placeholder Reality keys", () => {
  expect(() =>
    loadAdminConfig({
      APP_ENV: "production",
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "https://panel.example.com",
      DOMAIN: "proxy.example.com",
      PANEL_DOMAIN: "panel.example.com",
      ACME_EMAIL: "ops@example.com",
    }),
  ).toThrow("REALITY_PRIVATE_KEY");
});

test("test config has safe defaults and no public signup", () => {
  const cfg = loadAdminConfig({
    CT_ADMIN_ENV: "test",
    BETTER_AUTH_SECRET: SECRET,
    DOMAIN: "proxy.example.com",
    PANEL_DOMAIN: "panel.example.com",
  });
  expect(cfg.publicSignup).toBe(false);
  expect(cfg.secureCookies).toBe(false);
  expect(cfg.baseUrl).toBe("http://localhost:9000");
});

test("production refuses to disable secure cookies", () => {
  expect(() =>
    loadAdminConfig({
      CT_ADMIN_ENV: "production",
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "https://panel.example.com",
      DOMAIN: "proxy.example.com",
      PANEL_DOMAIN: "panel.example.com",
      ACME_EMAIL: "ops@example.com",
      REALITY_PRIVATE_KEY: "B".repeat(43),
      REALITY_PUBLIC_KEY: "C".repeat(43),
      CT_ADMIN_SECURE_COOKIES: "false",
    }),
  ).toThrow("cannot be disabled in production");
});

test("CT_AUDIT_RETENTION_DAYS defaults to 90 and parses integers", () => {
  const base = {
    APP_ENV: "production",
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: "https://panel.example.com",
    DOMAIN: "proxy.example.com",
    PANEL_DOMAIN: "panel.example.com",
    ACME_EMAIL: "ops@example.com",
    REALITY_PRIVATE_KEY: "B".repeat(43),
    REALITY_PUBLIC_KEY: "C".repeat(43),
  };
  expect(loadAdminConfig(base).auditRetentionDays).toBe(90);
  expect(loadAdminConfig({ ...base, CT_AUDIT_RETENTION_DAYS: "30" }).auditRetentionDays).toBe(30);
  expect(loadAdminConfig({ ...base, CT_AUDIT_RETENTION_DAYS: "0" }).auditRetentionDays).toBe(0);
  expect(() => loadAdminConfig({ ...base, CT_AUDIT_RETENTION_DAYS: "-1" })).toThrow(
    "non-negative integer",
  );
  expect(() => loadAdminConfig({ ...base, CT_AUDIT_RETENTION_DAYS: "abc" })).toThrow(
    "non-negative integer",
  );
});

test("CT_REDIS_URL defaults to redis://redis:6379 and accepts overrides", () => {
  const base = {
    APP_ENV: "production",
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: "https://panel.example.com",
    DOMAIN: "proxy.example.com",
    PANEL_DOMAIN: "panel.example.com",
    ACME_EMAIL: "ops@example.com",
    REALITY_PRIVATE_KEY: "B".repeat(43),
    REALITY_PUBLIC_KEY: "C".repeat(43),
  };
  expect(loadAdminConfig(base).redisUrl).toBe("redis://redis:6379");
  expect(loadAdminConfig({ ...base, CT_REDIS_URL: "redis://1.2.3.4:7777" }).redisUrl).toBe(
    "redis://1.2.3.4:7777",
  );
});
