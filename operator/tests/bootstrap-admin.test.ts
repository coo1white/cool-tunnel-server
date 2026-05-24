// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "bun:test";
import {
    BETTER_AUTH_SECRET_KEY,
    ensureAdminAuthSecret,
    generateAdminAuthSecret,
} from "../src/util/bootstrap-admin";

test("Better Auth secret is generated when missing", () => {
    const r = ensureAdminAuthSecret("DOMAIN=proxy.example.com\n", () => "x".repeat(43));

    expect(r.changed).toBe(true);
    expect(r.secret).toBe("x".repeat(43));
    expect(r.content).toContain(`${BETTER_AUTH_SECRET_KEY}=${"x".repeat(43)}`);
});

test("Better Auth secret preserves existing strong value", () => {
    const env = `${BETTER_AUTH_SECRET_KEY}=${"y".repeat(43)}\n`;
    const r = ensureAdminAuthSecret(env, () => "new-secret");

    expect(r.changed).toBe(false);
    expect(r.secret).toBe("y".repeat(43));
    expect(r.content).toBe(env);
});

test("generated Better Auth secret is URL-safe and strong", () => {
    const secret = generateAdminAuthSecret();

    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
});
