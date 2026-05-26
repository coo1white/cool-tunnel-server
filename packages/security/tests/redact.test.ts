// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "bun:test";
import { maskSensitive, redactSensitive } from "../src/index";

test("redacts free-form secrets, URLs, cookies, and UUIDs", () => {
  const text = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "Cookie: ct-admin.session_token=secret",
    "DATABASE_URL=mysql://user:pass@example/db",
    "DB_URL=postgres://admin:pass@example/db",
    "https://user:pass@example.com/internal",
    "https://panel.example.com/api/v1/subscription/abc123SECRET",
    "bearer plain-secret-token",
    "/setup/bootstrap?token=ctbt_secretsecretsecretsecretsecret",
    "123e4567-e89b-12d3-a456-426614174000",
  ].join("\n");
  const redacted = redactSensitive(text);
  expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz");
  expect(redacted).not.toContain("user:pass");
  expect(redacted).not.toContain("admin:pass");
  expect(redacted).not.toContain("plain-secret-token");
  expect(redacted).not.toContain("abc123SECRET");
  expect(redacted).not.toContain("123e4567");
});

test("masks object details recursively", () => {
  const masked = maskSensitive({
    password: "correct horse battery staple",
    nested: { subscriptionUrl: "https://x/api/v1/subscription/secret", safe: "visible" },
  });
  expect(JSON.stringify(masked)).not.toContain("correct horse");
  expect(JSON.stringify(masked)).not.toContain("secret");
  expect(JSON.stringify(masked)).toContain("visible");
});
