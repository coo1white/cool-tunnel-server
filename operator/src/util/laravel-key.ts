// SPDX-License-Identifier: AGPL-3.0-only
// Secret-safe diagnostics for Laravel APP_KEY / APP_PREVIOUS_KEYS.

import type { EnvMap } from "./env";
import { loadDotenv, mergeEnv } from "./env";

export type LaravelKeyStatus = "ok" | "missing" | "malformed";

export interface LaravelKeyDiagnostic {
    readonly status: LaravelKeyStatus;
    readonly detail: string;
    readonly hint: string;
}

function decodedLaravelKeyLength(value: string): number | null {
    const key = value.trim();
    if (!key.startsWith("base64:")) return null;
    const encoded = key.slice("base64:".length);
    if (encoded === "") return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;

    try {
        const bytes = Buffer.from(encoded, "base64");
        return bytes.length;
    } catch {
        return null;
    }
}

export function describeLaravelKey(name: string, value: string | undefined): LaravelKeyDiagnostic {
    const trimmed = (value ?? "").trim();
    if (trimmed === "") {
        return {
            status: "missing",
            detail: `${name} is empty or unset`,
            hint: "Generate a key with: docker compose exec -T panel php artisan key:generate --show",
        };
    }

    const length = decodedLaravelKeyLength(trimmed);
    if (length === 32) {
        return {
            status: "ok",
            detail: `${name} is present and decodes to 32 bytes`,
            hint: "",
        };
    }

    const observed = length === null ? "not valid base64:<value>" : `decodes to ${length} bytes`;
    return {
        status: "malformed",
        detail: `${name} is malformed (${observed}); Laravel AES-256-GCM requires 32 decoded bytes`,
        hint: `Fix ${name} in .env. Expected format: ${name}=base64:<44 chars from php artisan key:generate --show>`,
    };
}

export function splitPreviousKeys(value: string | undefined): string[] {
    return (value ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
}

export function summarizeLaravelKeyEnv(env: EnvMap): readonly string[] {
    const lines: string[] = [];
    const appKey = describeLaravelKey("APP_KEY", env["APP_KEY"]);
    lines.push(appKey.detail);
    if (appKey.hint) lines.push(appKey.hint);

    const previous = splitPreviousKeys(env["APP_PREVIOUS_KEYS"]);
    if (previous.length === 0) {
        lines.push("APP_PREVIOUS_KEYS has 0 entries");
        return lines;
    }

    const malformed = previous
        .map((key, index) => ({ index: index + 1, diagnostic: describeLaravelKey(`APP_PREVIOUS_KEYS[${index + 1}]`, key) }))
        .filter((entry) => entry.diagnostic.status !== "ok");

    if (malformed.length === 0) {
        lines.push(`APP_PREVIOUS_KEYS has ${previous.length} valid entr${previous.length === 1 ? "y" : "ies"}`);
        return lines;
    }

    lines.push(`APP_PREVIOUS_KEYS has ${previous.length} entries, ${malformed.length} malformed`);
    for (const entry of malformed.slice(0, 3)) {
        lines.push(entry.diagnostic.detail);
    }
    lines.push("Fix or remove malformed APP_PREVIOUS_KEYS entries, then run: docker compose restart panel && ct recover diagnose");
    return lines;
}

export function encryptionFailureHint(env: EnvMap, context: "render" | "recover" | "update"): readonly string[] {
    const summary = summarizeLaravelKeyEnv(env);
    const current = describeLaravelKey("APP_KEY", env["APP_KEY"]);
    const previous = splitPreviousKeys(env["APP_PREVIOUS_KEYS"]);
    const badPrevious = previous.filter((key) => describeLaravelKey("APP_PREVIOUS_KEYS", key).status !== "ok").length;
    const action = context === "update" ? "ct recover diagnose" : `ct ${context} ${context === "render" ? "singbox" : "diagnose"}`;

    if (current.status !== "ok") {
        return [
            "panel encryption failed because APP_KEY is missing or malformed",
            ...summary,
            `After fixing .env, run: docker compose restart panel && ${action}`,
        ];
    }
    if (badPrevious > 0) {
        return [
            "panel encryption failed because APP_PREVIOUS_KEYS contains malformed fallback keys",
            ...summary,
            "Malformed previous keys can break Laravel before the panel can boot.",
        ];
    }
    return [
        "panel encryption failed even though APP_KEY format looks valid",
        ...summary,
        "Likely cause: APP_KEY was changed after encrypted Reality data was written.",
        "Restore the old APP_KEY or add it to APP_PREVIOUS_KEYS. If the old key is gone, run: ct recover reset-reality",
    ];
}

export async function loadLaravelKeyEnv(cwd = process.cwd(), base: EnvMap = process.env as EnvMap): Promise<EnvMap> {
    const dotenv = await loadDotenv([`${cwd}/.env`, `${cwd}/../.env`, ".env"]);
    return mergeEnv(base, dotenv?.env ?? null);
}
