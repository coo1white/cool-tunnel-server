// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "bun:test";
import {
    BOOTSTRAP_ADMIN_PASSWORD_KEY,
    ensureBootstrapAdminPassword,
    generateBootstrapAdminPassword,
} from "../src/util/bootstrap-admin";

test("bootstrap admin password is generated when missing", () => {
    const r = ensureBootstrapAdminPassword("DOMAIN=proxy.example.com\n", () => "local-only-secret-2026");

    expect(r.changed).toBe(true);
    expect(r.password).toBe("local-only-secret-2026");
    expect(r.content).toContain(`${BOOTSTRAP_ADMIN_PASSWORD_KEY}=local-only-secret-2026`);
});

test("bootstrap admin password preserves existing local value", () => {
    const env = `${BOOTSTRAP_ADMIN_PASSWORD_KEY}=existing-local-secret\n`;
    const r = ensureBootstrapAdminPassword(env, () => "new-secret");

    expect(r.changed).toBe(false);
    expect(r.password).toBe("existing-local-secret");
    expect(r.content).toBe(env);
});

test("generated bootstrap admin password is non-empty and shell-safe", () => {
    const password = generateBootstrapAdminPassword();

    expect(password.length).toBeGreaterThanOrEqual(32);
    expect(password).toMatch(/^[A-Za-z0-9]+$/);
});
