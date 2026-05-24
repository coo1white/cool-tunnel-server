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
