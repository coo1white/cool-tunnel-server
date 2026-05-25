// SPDX-License-Identifier: AGPL-3.0-only

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_ACME_DIRECTORY,
  DEFAULT_DOH_RESOLVER,
  DEFAULT_REALITY_DEST_HOST,
  RELEASE_VERSION,
} from "@cool-tunnel/shared";
import {
  normalizeDomain,
  normalizeEmail,
  requireSessionSecret,
  validateSafePath,
  validateUrl,
} from "@cool-tunnel/security";

export type EnvMap = Record<string, string | undefined>;

export interface AdminConfig {
  readonly appEnv: "production" | "development" | "test";
  readonly host: string;
  readonly port: number;
  readonly panelDomain: string;
  readonly domain: string;
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
  readonly acmeEmail: string;
  readonly acmeDirectory: string;
  readonly realityPrivateKey: string;
  readonly realityPublicKey: string;
  readonly realityDestHost: string;
  readonly realityShortIds: readonly string[];
  readonly antiTrackingDohResolver: string;
  readonly version: string;
}

export function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`invalid boolean value "${value}"`);
}

function envValue(env: EnvMap, key: string, fallback = ""): string {
  return env[key] ?? fallback;
}

const PLACEHOLDER_REALITY_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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

export function defaultAdminDbPath(env: EnvMap): string {
  const dbUrl = envValue(env, "DATABASE_URL");
  if (dbUrl.startsWith("sqlite://")) return dbUrl.replace(/^sqlite:\/\//, "");
  const appEnv = (env["CT_ADMIN_ENV"] ?? env["APP_ENV"] ?? "").trim().toLowerCase();
  if (appEnv === "test") return envValue(env, "CT_ADMIN_DB_PATH") || "/tmp/cool-tunnel-admin-test.sqlite";
  return envValue(env, "CT_ADMIN_DB_PATH") || "./data/admin/admin.sqlite";
}

export function bootstrapMaterialPath(config: Pick<AdminConfig, "dbPath">): string {
  return `${dirname(config.dbPath)}/bootstrap-setup-url.txt`;
}

export function loadAdminConfig(env: EnvMap = process.env as EnvMap): AdminConfig {
  const appEnv = parseAppEnv(envValue(env, "CT_ADMIN_ENV") || envValue(env, "APP_ENV"));
  const port = parsePort(envValue(env, "CT_ADMIN_PORT"));
  const domain = normalizeDomain(envValue(env, "DOMAIN") || "localhost.localdomain", "DOMAIN");
  const panelDomain = normalizeDomain(envValue(env, "PANEL_DOMAIN") || `panel.${domain}`, "PANEL_DOMAIN");
  const defaultBase = appEnv === "production" ? `https://${panelDomain}` : `http://localhost:${port}`;
  const baseUrlRaw = envValue(env, "BETTER_AUTH_URL") || envValue(env, "APP_URL") || defaultBase;
  const url = new URL(baseUrlRaw);
  const secureCookies = parseBool(envValue(env, "CT_ADMIN_SECURE_COOKIES"), appEnv === "production");
  if (appEnv === "production" && secureCookies && url.protocol !== "https:") {
    throw new Error("BETTER_AUTH_URL/APP_URL must use https:// in production when secure admin cookies are enabled");
  }
  const ttl = Number(envValue(env, "CT_ADMIN_BOOTSTRAP_TOKEN_TTL_MINUTES") || "15");
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 120) {
    throw new Error("CT_ADMIN_BOOTSTRAP_TOKEN_TTL_MINUTES must be an integer from 1 to 120");
  }
  const acmeDirectory = envValue(env, "ACME_DIRECTORY") || DEFAULT_ACME_DIRECTORY;
  if (!validateUrl(acmeDirectory, ["https:"])) throw new Error("ACME_DIRECTORY must be an https URL");
  const dohResolver = envValue(env, "ANTI_TRACKING_DOH_RESOLVER") || DEFAULT_DOH_RESOLVER;
  if (!validateUrl(dohResolver, ["https:"])) throw new Error("ANTI_TRACKING_DOH_RESOLVER must be an https URL");
  const realityPrivateKey = validateRealityKey(envValue(env, "REALITY_PRIVATE_KEY") || PLACEHOLDER_REALITY_KEY, "REALITY_PRIVATE_KEY");
  const realityPublicKey = validateRealityKey(envValue(env, "REALITY_PUBLIC_KEY") || PLACEHOLDER_REALITY_KEY, "REALITY_PUBLIC_KEY");
  if (appEnv === "production" && (realityPrivateKey === PLACEHOLDER_REALITY_KEY || realityPublicKey === PLACEHOLDER_REALITY_KEY)) {
    throw new Error("REALITY_PRIVATE_KEY and REALITY_PUBLIC_KEY must be set to generated keys in production");
  }

  const dbPath = resolve(defaultAdminDbPath(env));
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(dbPath), 0o700);
  } catch {
    // Best effort for bind mounts and non-POSIX filesystems.
  }

  return {
    appEnv,
    host: envValue(env, "CT_ADMIN_HOST") || "0.0.0.0",
    port,
    panelDomain,
    domain,
    baseUrl: url.origin,
    trustedOrigins: [
      url.origin,
      `https://${panelDomain}`,
      appEnv !== "production" ? `http://localhost:${port}` : "",
    ].filter(Boolean),
    authSecret: requireSessionSecret(env),
    dbPath,
    publicSignup: parseBool(envValue(env, "CT_PUBLIC_SIGNUP"), false),
    secureCookies,
    bootstrapTokenTtlMinutes: ttl,
    coreSocket: validateSafePath(envValue(env, "CT_CORE_SOCKET") || "/run/cool-tunnel/core.sock", "CT_CORE_SOCKET"),
    caddyfilePath: validateSafePath(envValue(env, "CADDYFILE_PATH") || "/etc/caddy/Caddyfile", "CADDYFILE_PATH"),
    caddyfileTemplate: validateSafePath(envValue(env, "CADDYFILE_TEMPLATE") || "/srv/caddy/Caddyfile.tpl", "CADDYFILE_TEMPLATE"),
    singboxConfigPath: validateSafePath(envValue(env, "SINGBOX_CONFIG_PATH") || "/data/config/singbox.json", "SINGBOX_CONFIG_PATH"),
    manifestsDir: validateSafePath(envValue(env, "CT_MANIFESTS_DIR") || "/srv/manifests", "CT_MANIFESTS_DIR"),
    acmeEmail: normalizeEmail(envValue(env, "ACME_EMAIL") || "admin@example.com"),
    acmeDirectory,
    realityPrivateKey,
    realityPublicKey,
    realityDestHost: normalizeDomain(envValue(env, "REALITY_DEST_HOST") || DEFAULT_REALITY_DEST_HOST, "REALITY_DEST_HOST"),
    realityShortIds: validateShortIds(envValue(env, "REALITY_SHORT_IDS")),
    antiTrackingDohResolver: dohResolver,
    version: RELEASE_VERSION,
  };
}
