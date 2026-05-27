// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "bun:test";
import { loadAdminConfig } from "../src/index";

const SECRET = "test-better-auth-secret-".padEnd(43, "x");

test("production requires https when secure cookies are enabled", () => {
  expect(() => loadAdminConfig({
    APP_ENV: "production",
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: "http://panel.example.com",
    DOMAIN: "proxy.example.com",
    PANEL_DOMAIN: "panel.example.com",
  })).toThrow("https://");
});

test("production rejects placeholder Reality keys", () => {
  expect(() => loadAdminConfig({
    APP_ENV: "production",
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: "https://panel.example.com",
    DOMAIN: "proxy.example.com",
    PANEL_DOMAIN: "panel.example.com",
    ACME_EMAIL: "ops@example.com",
  })).toThrow("REALITY_PRIVATE_KEY");
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
  expect(() => loadAdminConfig({
    CT_ADMIN_ENV: "production",
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: "https://panel.example.com",
    DOMAIN: "proxy.example.com",
    PANEL_DOMAIN: "panel.example.com",
    ACME_EMAIL: "ops@example.com",
    REALITY_PRIVATE_KEY: "A".repeat(43),
    REALITY_PUBLIC_KEY: "B".repeat(43),
    CT_ADMIN_SECURE_COOKIES: "false",
  })).toThrow("cannot be disabled in production");
});
