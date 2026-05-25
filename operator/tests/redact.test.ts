// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/redact.test.ts

import { expect, test } from "bun:test";
import { redactSensitive } from "../src/util/redact";

test("redactSensitive masks subscription URL tokens", () => {
    const out = redactSensitive(
        "open https://panel.example.com/api/v1/subscription/abcDEF_123-xyz now",
    );
    expect(out).toBe("open https://panel.example.com/api/v1/subscription/<redacted> now");
});

test("redactSensitive masks env secrets without hiding key names", () => {
    const out = redactSensitive(
        'APP_KEY=base64:abcdefghijklmnop1234567890ABCDEFGHIJKLMNOP== DB_PASSWORD="super-secret" REDISCLI_AUTH=redis-secret',
    );
    expect(out).toContain("APP_KEY=<redacted>");
    expect(out).toContain('DB_PASSWORD="<redacted>"');
    expect(out).toContain("REDISCLI_AUTH=<redacted>");
    expect(out).not.toContain("super-secret");
    expect(out).not.toContain("redis-secret");
});

test("redactSensitive masks JSON/PHP secret fields and UUIDs", () => {
    const out = redactSensitive(
        '{"uuid":"11111111-2222-4333-8444-555555555555","reality_private_key":"priv","subscription_secret":"sub"} ' +
            "'private_key' => 'legacy-private'",
    );
    expect(out).toContain('"uuid":"<redacted>"');
    expect(out).toContain('"reality_private_key":"<redacted>"');
    expect(out).toContain('"subscription_secret":"<redacted>"');
    expect(out).toContain("'private_key' => '<redacted>'");
    expect(out).not.toContain("11111111-2222-4333-8444-555555555555");
    expect(out).not.toContain("legacy-private");
});

test("redactSensitive masks credential-bearing query strings and auth headers", () => {
    const out = redactSensitive([
        "GET /login?email=user@example.test&password=not-for-logs HTTP/2",
        "GET /setup/bootstrap?token=ctbt_secretTokenValue1234567890abcdef",
        "Authorization: Bearer abc.def.secret-token-value",
        "Cookie: ct-admin.session_token=session-secret; other=value",
        "Set-Cookie: ct-admin.session_token=session-secret; HttpOnly",
        "/callback?session_token=session-secret&api_key=api-secret",
        "DATABASE_URL=mysql://user:secret-pass@db:3306/app",
        "REDIS_URL=redis://:redis-secret@redis:6379/0",
        "SOME_PRIVATE_KEY: private-key-secret",
        "CT_TOKEN=token-secret",
    ].join("\n"));

    expect(out).toContain("password=<redacted>");
    expect(out).toContain("token=<redacted>");
    expect(out).toContain("Authorization: Bearer <redacted>");
    expect(out).toContain("Cookie: <redacted>");
    expect(out).toContain("Set-Cookie: <redacted>");
    expect(out).toContain("session_token=<redacted>");
    expect(out).toContain("api_key=<redacted>");
    expect(out).not.toContain("not-for-logs");
    expect(out).not.toContain("session-secret");
    expect(out).not.toContain("api-secret");
    expect(out).not.toContain("secret-pass");
    expect(out).not.toContain("redis-secret");
    expect(out).not.toContain("private-key-secret");
    expect(out).not.toContain("token-secret");
});
