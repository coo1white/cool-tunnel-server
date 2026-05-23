// SPDX-License-Identifier: AGPL-3.0-only
// Helpers for the first admin's VPS-local bootstrap password.

export const BOOTSTRAP_ADMIN_PASSWORD_KEY = "CT_BOOTSTRAP_ADMIN_PASSWORD";

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export interface BootstrapAdminPasswordResult {
    readonly content: string;
    readonly password: string;
    readonly changed: boolean;
}

export function generateBootstrapAdminPassword(length = 32): string {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.max(16, length)));
    let out = "";
    for (const b of bytes) {
        out += PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length];
    }
    return out;
}

export function ensureBootstrapAdminPassword(
    content: string,
    generate: () => string = generateBootstrapAdminPassword,
): BootstrapAdminPasswordResult {
    const existing = envValue(content, BOOTSTRAP_ADMIN_PASSWORD_KEY);
    if (existing !== null && existing !== "") {
        return { content, password: existing, changed: false };
    }

    const password = generate();
    return {
        content: upsertEnvValue(content, BOOTSTRAP_ADMIN_PASSWORD_KEY, password),
        password,
        changed: true,
    };
}

function envValue(content: string, key: string): string | null {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = content.match(new RegExp(`^${escaped}=(.*)$`, "m"));
    if (!match) return null;

    let value = match[1] ?? "";
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        value = value.slice(1, -1);
    }
    return value.trim();
}

function upsertEnvValue(content: string, key: string, value: string): string {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lines = content.split("\n");
    const idx = lines.findIndex((line) => new RegExp(`^${escaped}=`).test(line));
    if (idx >= 0) {
        lines[idx] = `${key}=${value}`;
    } else {
        if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
        lines.push(`${key}=${value}`);
    }
    return lines.join("\n");
}
