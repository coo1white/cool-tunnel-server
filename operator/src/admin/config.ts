// SPDX-License-Identifier: AGPL-3.0-only
// Admin server configuration. Defaults are single-VPS friendly.

import { mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EnvMap } from "../util/env";

export interface AdminConfig {
    readonly appEnv: "production" | "development" | "test";
    readonly host: string;
    readonly port: number;
    readonly panelDomain: string;
    readonly baseUrl: string;
    readonly trustedOrigins: readonly string[];
    readonly authSecret: string;
    readonly dbPath: string;
    readonly publicSignup: boolean;
    readonly secureCookies: boolean;
    readonly bootstrapTokenTtlMinutes: number;
    readonly coreSocket: string;
    readonly caddyfilePath: string;
    readonly caddyfileTemplate: string;
    readonly singboxConfigPath: string;
    readonly manifestsDir: string;
    readonly domain: string;
    readonly acmeEmail: string;
    readonly acmeDirectory: string;
    readonly realityPrivateKey: string;
    readonly realityPublicKey: string;
    readonly realityDestHost: string;
    readonly realityShortIds: readonly string[];
}

export function parseBool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value.trim() === "") return fallback;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    throw new Error(`invalid boolean value "${value}"`);
}

export function validateDomain(value: string, label = "domain"): string {
    const domain = value.trim().toLowerCase();
    if (domain.length < 1 || domain.length > 253) {
        throw new Error(`${label} must be 1-253 characters`);
    }
    if (domain.includes("..") || domain.startsWith(".") || domain.endsWith(".")) {
        throw new Error(`${label} must be a valid DNS name`);
    }
    const labels = domain.split(".");
    for (const part of labels) {
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) {
            throw new Error(`${label} has invalid label "${part}"`);
        }
    }
    return domain;
}

export function validateEmail(value: string, label = "email"): string {
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new Error(`${label} must be a valid email address`);
    }
    return email;
}

export function validateRealityKey(value: string, label: string): string {
    const key = value.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) {
        throw new Error(`${label} must be a 43-character base64url X25519 key`);
    }
    return key;
}

export function validateShortIds(value: string | undefined): readonly string[] {
    if (!value || value.trim() === "") return [""];
    const parts = value.split(",").map((part) => part.trim());
    if (parts.length === 0 || parts.length > 16) {
        throw new Error("REALITY_SHORT_IDS must contain 1-16 comma-separated short IDs");
    }
    for (const part of parts) {
        if (part !== "" && !/^[0-9a-fA-F]{2,16}$/.test(part)) {
            throw new Error("REALITY_SHORT_IDS entries must be empty or 2-16 hex characters");
        }
    }
    return parts;
}

export function validateUserId(value: string): string {
    const id = value.trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
        throw new Error("user id must be 8-128 URL-safe characters");
    }
    return id;
}

export function validateSafePath(value: string, label: string): string {
    const path = value.trim();
    if (!path.startsWith("/")) {
        throw new Error(`${label} must be an absolute path`);
    }
    if (path.includes("\0") || path.split("/").includes("..")) {
        throw new Error(`${label} must not contain NUL or '..' segments`);
    }
    return path;
}

function envValue(env: EnvMap, key: string, fallback = ""): string {
    return env[key] ?? fallback;
}

function parsePort(value: string | undefined): number {
    const trimmed = value?.trim();
    const port = Number(trimmed && trimmed.length > 0 ? trimmed : "9000");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("CT_ADMIN_PORT must be an integer TCP port from 1 to 65535");
    }
    return port;
}

function parseAppEnv(value: string | undefined): AdminConfig["appEnv"] {
    const env = (value || "production").trim().toLowerCase();
    if (env === "production" || env === "development" || env === "test") return env;
    throw new Error("APP_ENV/CT_ADMIN_ENV must be production, development, or test");
}

export function requireSecret(env: EnvMap): string {
    const secret = envValue(env, "BETTER_AUTH_SECRET") || envValue(env, "AUTH_SECRET");
    if (!secret) {
        throw new Error("BETTER_AUTH_SECRET is required. Generate one with: openssl rand -base64 32");
    }
    if (secret.length < 32) {
        throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
    }
    return secret;
}

export function generateAdminSecret(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Buffer.from(bytes).toString("base64url");
}

export function defaultAdminDbPath(env: EnvMap): string {
    return envValue(env, "CT_ADMIN_DB_PATH") || "/data/admin/admin.sqlite";
}

export function loadAdminConfig(env: EnvMap = process.env as EnvMap): AdminConfig {
    const appEnv = parseAppEnv(envValue(env, "CT_ADMIN_ENV") || envValue(env, "APP_ENV"));
    const domain = validateDomain(envValue(env, "DOMAIN") || "localhost.localdomain", "DOMAIN");
    const panelDomain = validateDomain(
        envValue(env, "PANEL_DOMAIN") || `panel.${domain}`,
        "PANEL_DOMAIN",
    );
    const defaultBase = appEnv === "development" || appEnv === "test"
        ? `http://localhost:${parsePort(envValue(env, "CT_ADMIN_PORT"))}`
        : `https://${panelDomain}`;
    const baseUrl = envValue(env, "BETTER_AUTH_URL") || envValue(env, "APP_URL") || defaultBase;
    const url = new URL(baseUrl);
    const trustedOrigins = [
        url.origin,
        `https://${panelDomain}`,
        appEnv !== "production" ? `http://localhost:${parsePort(envValue(env, "CT_ADMIN_PORT"))}` : "",
    ].filter(Boolean);
    const secureCookies = parseBool(envValue(env, "CT_ADMIN_SECURE_COOKIES"), appEnv === "production");
    if (appEnv === "production" && secureCookies && url.protocol !== "https:") {
        throw new Error("BETTER_AUTH_URL/APP_URL must use https:// in production when secure admin cookies are enabled");
    }
    const ttl = Number(envValue(env, "CT_ADMIN_BOOTSTRAP_TOKEN_TTL_MINUTES") || "15");
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 120) {
        throw new Error("CT_ADMIN_BOOTSTRAP_TOKEN_TTL_MINUTES must be an integer from 1 to 120");
    }

    const dbPath = resolve(defaultAdminDbPath(env));
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    try {
        chmodSync(dirname(dbPath), 0o700);
    } catch {
        // Best effort: bind mounts may not permit chmod, doctor reports mode.
    }

    return {
        appEnv,
        host: envValue(env, "CT_ADMIN_HOST") || "0.0.0.0",
        port: parsePort(envValue(env, "CT_ADMIN_PORT")),
        panelDomain,
        baseUrl: url.origin,
        trustedOrigins,
        authSecret: requireSecret(env),
        dbPath,
        publicSignup: parseBool(envValue(env, "CT_PUBLIC_SIGNUP"), false),
        secureCookies,
        bootstrapTokenTtlMinutes: ttl,
        coreSocket: validateSafePath(envValue(env, "CT_CORE_SOCKET") || "/run/cool-tunnel/core.sock", "CT_CORE_SOCKET"),
        caddyfilePath: validateSafePath(envValue(env, "CADDYFILE_PATH") || "/etc/caddy/Caddyfile", "CADDYFILE_PATH"),
        caddyfileTemplate: validateSafePath(envValue(env, "CADDYFILE_TEMPLATE") || "/srv/caddy/Caddyfile.tpl", "CADDYFILE_TEMPLATE"),
        singboxConfigPath: validateSafePath(envValue(env, "SINGBOX_CONFIG_PATH") || "/data/config/singbox.json", "SINGBOX_CONFIG_PATH"),
        manifestsDir: validateSafePath(envValue(env, "CT_MANIFESTS_DIR") || "/srv/manifests", "CT_MANIFESTS_DIR"),
        domain,
        acmeEmail: validateEmail(envValue(env, "ACME_EMAIL") || "admin@example.com", "ACME_EMAIL"),
        acmeDirectory: envValue(env, "ACME_DIRECTORY") || "https://acme-v02.api.letsencrypt.org/directory",
        realityPrivateKey: validateRealityKey(envValue(env, "REALITY_PRIVATE_KEY") || "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "REALITY_PRIVATE_KEY"),
        realityPublicKey: validateRealityKey(envValue(env, "REALITY_PUBLIC_KEY") || "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "REALITY_PUBLIC_KEY"),
        realityDestHost: validateDomain(envValue(env, "REALITY_DEST_HOST") || "www.microsoft.com", "REALITY_DEST_HOST"),
        realityShortIds: validateShortIds(envValue(env, "REALITY_SHORT_IDS")),
    };
}
