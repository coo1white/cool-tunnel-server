// SPDX-License-Identifier: AGPL-3.0-only
// Helpers for admin auth secrets in .env. The first owner is created
// by one-time token, never by a generated default password.

export const BETTER_AUTH_SECRET_KEY = "BETTER_AUTH_SECRET";

export interface AdminAuthSecretResult {
    readonly content: string;
    readonly secret: string;
    readonly changed: boolean;
}

export function generateAdminAuthSecret(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Buffer.from(bytes).toString("base64url");
}

export function ensureAdminAuthSecret(
    content: string,
    generate: () => string = generateAdminAuthSecret,
): AdminAuthSecretResult {
    const existing = envValue(content, BETTER_AUTH_SECRET_KEY) ?? envValue(content, "AUTH_SECRET");
    if (existing !== null && existing.length >= 32) {
        return { content, secret: existing, changed: false };
    }

    const secret = generate();
    return {
        content: upsertEnvValue(content, BETTER_AUTH_SECRET_KEY, secret),
        secret,
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
