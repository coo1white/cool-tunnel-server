// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, timingSafeEqual } from "node:crypto";

import type { AdminRole } from "@cool-tunnel/shared";

const SECRET_ENV_KEYS = [
  "APP_KEY",
  "APP_PREVIOUS_KEYS",
  "DB_PASSWORD",
  "DB_ROOT_PASSWORD",
  "MYSQL_PASSWORD",
  "REDIS_PASSWORD",
  "MYSQL_PWD",
  "REDISCLI_AUTH",
  "CT_BOOTSTRAP_ADMIN_PASSWORD",
  "BETTER_AUTH_SECRET",
  "AUTH_SECRET",
  "BETTER_AUTH_SECRETS",
  "CT_ADMIN_BOOTSTRAP_TOKEN",
  "CT_ADMIN_SESSION_SECRET",
  "SESSION_COOKIE",
  "COOKIE",
  "AUTHORIZATION",
  "DATABASE_URL",
  "DB_URL",
  "REDIS_URL",
  "SQLITE_URL",
  "REALITY_PRIVATE_KEY",
  "REALITY_PUBLIC_KEY",
  "ACME_EMAIL",
  "PANEL_DOMAIN",
  "DOMAIN",
];

const SECRET_JSON_KEYS = [
  "emailAddress",
  "adminEmail",
  "email",
  "password",
  "passwd",
  "token",
  "access_token",
  "refresh_token",
  "session",
  "session_token",
  "sessionToken",
  "subscription_secret",
  "subscriptionSecret",
  "subscriptionUrl",
  "subscription_url",
  "bootstrap_token",
  "bootstrapToken",
  "tokenHash",
  "setupUrl",
  "reality_private_key",
  "realityPrivateKey",
  "private_key",
  "privateKey",
  "uuid",
  "previous_uuid",
  "api_key",
  "apiKey",
  "cookie",
  "authorization",
];

const SECRET_QUERY_KEYS = [
  "password",
  "passwd",
  "token",
  "bootstrap_token",
  "session",
  "session_token",
  "sessionToken",
  "cookie",
  "authorization",
  "bearer",
  "api_key",
  "apiKey",
];

const SECRETISH_KEY =
  /(password|passwd|pwd|token|secret|cookie|session|authorization|uuid|subscription|database_url|db_url|redis_url|private[_-]?key|api[_-]?key)/i;

// Keys whose name *contains* a SECRETISH word but whose VALUE is not itself
// a secret — typically derived/metadata fields produced alongside a secret.
// Without this allowlist, audit/log entries lose useful operator context
// (e.g. `previousUuidValidUntil` is a timestamp, `tokenFingerprint` is a
// one-way-hashed correlation handle deliberately stored as non-secret).
//
// Match is suffix-based, case-insensitive: any key whose tail is one of
// these is treated as non-secret and its value is recursed-into normally.
const SAFE_KEY_SUFFIXES = [
  "ValidUntil",
  "ExpiresAt",
  "CreatedAt",
  "UpdatedAt",
  "RotatedAt",
  "RevealedAt",
  "Fingerprint",
  "Hint",
] as const;

function isSafeMetadataKey(key: string): boolean {
  const k = key.toLowerCase();
  for (const suffix of SAFE_KEY_SUFFIXES) {
    if (k.endsWith(suffix.toLowerCase())) return true;
  }
  return false;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

export function randomId(): string {
  return crypto.randomUUID();
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("hex");
}

export async function hmacSha256Hex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Buffer.from(sig).toString("hex");
}

/**
 * Constant-time string comparison. Returns false (without leaking timing) when
 * lengths differ. Use for any secret/credential equality check — HMAC
 * signatures, CSRF tokens — where a plain `===`/`!==` is a timing oracle.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65536,
    timeCost: 3,
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

export function redactSensitive(text: string): string {
  let out = text;
  out = out.replace(
    /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_KEY|API_KEY|DATABASE_URL|DB_URL|SQLITE_URL|REDIS_URL)[A-Z0-9_]*\s*[:=]\s*)[^\s&,'"\\}<>]+/gi,
    "$1<redacted>",
  );
  out = out.replace(/\b(authorization:\s*)(\S+)(\s+[^\r\n]+)?/gi, (_m, p1, scheme, creds) =>
    creds ? `${p1}${scheme} <redacted>` : `${p1}<redacted>`,
  );
  out = out.replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi, "$1<redacted>");
  out = out.replace(/\b(cookie:\s*)[^\r\n]+/gi, "$1<redacted>");
  out = out.replace(/\b(set-cookie:\s*)[^\r\n]+/gi, "$1<redacted>");
  out = out.replace(
    /\b(mysql|mariadb|postgres|postgresql|redis|sqlite):\/\/[^\s'"<>]+/gi,
    "$1://<redacted>",
  );
  out = out.replace(/\b(https?:\/\/)[^:@\s'"<>/]+:[^@\s'"<>/]+@/gi, "$1<redacted>@");
  out = out.replace(
    /(https?:\/\/[^\s'"<>]+\/api\/v1\/subscription\/)[A-Za-z0-9_-]+/g,
    "$1<redacted>",
  );
  out = out.replace(/(\/api\/v1\/subscription\/)[A-Za-z0-9_-]+/g, "$1<redacted>");
  out = out.replace(/(\/setup(?:\/bootstrap)?\?token=)[A-Za-z0-9_-]+/g, "$1<redacted>");
  for (const key of SECRET_QUERY_KEYS) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`([?&]${escaped}=)[^\\s&#'"<>]+`, "gi"), "$1<redacted>");
  }
  out = out.replace(/\bctbt_[A-Za-z0-9_-]{20,}\b/g, "ctbt_<redacted>");
  out = out.replace(/\bbase64:[A-Za-z0-9+/=]{20,}\b/g, "base64:<redacted>");
  out = out.replace(
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g,
    "<uuid>",
  );
  for (const key of SECRET_ENV_KEYS) {
    out = out.replace(new RegExp(`\\b(${key})=([^\\s'"\\\\]+)`, "g"), "$1=<redacted>");
    out = out.replace(new RegExp(`\\b(${key})='[^']*'`, "g"), "$1='<redacted>'");
    out = out.replace(new RegExp(`\\b(${key})="[^"]*"`, "g"), '$1="<redacted>"');
  }
  for (const key of SECRET_JSON_KEYS) {
    out = out.replace(
      new RegExp(`("${key}"\\s*:\\s*")(?:\\\\.|[^"\\\\])*(")`, "gi"),
      "$1<redacted>$2",
    );
    out = out.replace(
      new RegExp(`('${key}'\\s*=>\\s*')(?:\\\\.|[^'\\\\])*(')`, "gi"),
      "$1<redacted>$2",
    );
  }
  return out;
}

export function maskSensitive(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSensitive(value);
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSafeMetadataKey(k)) {
        // Safe metadata (timestamp / fingerprint / hint) — recurse into the
        // value normally so an inner secret in a nested object is still
        // caught, but don't blanket-redact this key.
        out[k] = maskSensitive(v);
      } else if (SECRETISH_KEY.test(k)) {
        out[k] = "<redacted>";
      } else {
        out[k] = maskSensitive(v);
      }
    }
    return out;
  }
  return value;
}

export function auditDetail(detail: Record<string, unknown> = {}): string {
  return JSON.stringify(maskSensitive(detail));
}

export function maskSubscriptionUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/(\/api\/v1\/subscription\/)[A-Za-z0-9_-]+/, "$1<redacted>");
}

export function validateEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!validateEmail(email)) throw new Error("Enter a valid email address.");
  return email;
}

export function validateUsername(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}[a-zA-Z0-9]$/.test(value);
}

export function normalizeUsername(value: string): string {
  const username = value.trim();
  if (!validateUsername(username))
    throw new Error("Use 3-64 letters, numbers, dot, dash, or underscore.");
  return username;
}

export function validateName(value: string): boolean {
  return value.trim().length >= 1 && value.trim().length <= 120;
}

export function validatePassword(value: string): boolean {
  return value.length >= 12 && value.length <= 512;
}

export function validateUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function validateId(value: string): boolean {
  return (
    /^[A-Za-z0-9_-]{8,128}$/.test(value) || validateUuid(value) || /^[0-9a-f]{32}$/.test(value)
  );
}

export function validateDomain(value: string): boolean {
  const domain = value.trim().toLowerCase();
  if (domain.length < 1 || domain.length > 253) return false;
  if (domain.includes("..") || domain.startsWith(".") || domain.endsWith(".")) return false;
  return domain.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part));
}

export function normalizeDomain(value: string, label = "domain"): string {
  const domain =
    value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split(/[/:]/)[0] ?? "";
  if (!validateDomain(domain)) throw new Error(`${label} must be a valid DNS name.`);
  return domain;
}

export function validateUrl(value: string, protocols: readonly string[] = ["https:"]): boolean {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol);
  } catch {
    return false;
  }
}

export function validateSafePath(value: string, label: string): string {
  const path = value.trim();
  if (!path.startsWith("/")) throw new Error(`${label} must be an absolute path`);
  if (path.includes("\0") || path.split("/").includes(".."))
    throw new Error(`${label} must not contain NUL or '..' segments`);
  return path;
}

export function requireSessionSecret(env: Record<string, string | undefined>): string {
  const secret = env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET ?? env.CT_ADMIN_SESSION_SECRET ?? "";
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters.");
  return secret;
}

export function validateRole(value: string): value is AdminRole {
  return value === "owner" || value === "admin" || value === "operator" || value === "viewer";
}

export function generateBootstrapToken(): string {
  return `ctbt_${randomToken(32)}`;
}

export async function hashBootstrapToken(token: string, secret: string): Promise<string> {
  return hmacSha256Hex(token, secret);
}

export function tokenFingerprint(token: string): string {
  // Keyless but cryptographic (SHA-256) and collision-resistant, unlike the
  // previous non-cryptographic wyhash. Used only as an audit-log correlation
  // handle for bootstrap tokens — the 256-bit random preimage is never recoverable.
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function validBootstrapTokenShape(token: string): boolean {
  return /^ctbt_[A-Za-z0-9_-]{32,128}$/.test(token);
}
