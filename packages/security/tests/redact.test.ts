// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "bun:test";
import { constantTimeEqual, maskSensitive, maskSubscriptionUrl, redactSensitive } from "../src/index";

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

test("redacts non-Bearer Authorization schemes (Basic, token)", () => {
  const basic = redactSensitive("Authorization: Basic dXNlcjpzdXBlci1zZWNyZXQ=");
  expect(basic).toBe("Authorization: Basic <redacted>");
  expect(basic).not.toContain("dXNlcjpzdXBlci1zZWNyZXQ=");
  const scheme = redactSensitive("authorization: Digest realm-creds-here");
  expect(scheme).toBe("authorization: Digest <redacted>");
  const bare = redactSensitive("Authorization: raw-token-no-scheme");
  expect(bare).toBe("Authorization: <redacted>");
});

test("redacts JSON secret values containing escaped quotes without leaking the tail", () => {
  const redacted = redactSensitive('{"password":"ab\\"cd","ok":"keep"}');
  expect(redacted).not.toContain("cd");
  expect(redacted).toContain('"password":"<redacted>"');
  expect(redacted).toContain('"ok":"keep"');
});

test("maskSubscriptionUrl masks the token even with a trailing query or fragment", () => {
  expect(maskSubscriptionUrl("https://p/api/v1/subscription/TOKENSECRET?x=1")).toBe(
    "https://p/api/v1/subscription/<redacted>?x=1",
  );
  expect(maskSubscriptionUrl("https://p/api/v1/subscription/TOKENSECRET")).toBe(
    "https://p/api/v1/subscription/<redacted>",
  );
});

test("constantTimeEqual matches only equal strings and is length-safe", () => {
  expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  expect(constantTimeEqual("abc", "abcd")).toBe(false);
  expect(constantTimeEqual("", "")).toBe(true);
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
