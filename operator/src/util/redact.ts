// SPDX-License-Identifier: AGPL-3.0-only
// Secret-safe diagnostic redaction for operator output.

const SECRET_ENV_KEYS = [
    "APP_KEY",
    "APP_PREVIOUS_KEYS",
    "DB_PASSWORD",
    "DB_ROOT_PASSWORD",
    "REDIS_PASSWORD",
    "MYSQL_PWD",
    "REDISCLI_AUTH",
    "CT_BOOTSTRAP_ADMIN_PASSWORD",
    "BETTER_AUTH_SECRET",
    "AUTH_SECRET",
    "BETTER_AUTH_SECRETS",
    "CT_ADMIN_BOOTSTRAP_TOKEN",
    "SESSION_COOKIE",
    "COOKIE",
    "AUTHORIZATION",
];

const SECRET_JSON_KEYS = [
    "email",
    "emailAddress",
    "adminEmail",
    "password",
    "passwd",
    "token",
    "access_token",
    "refresh_token",
    "session",
    "session_token",
    "sessionToken",
    "subscription_secret",
    "bootstrap_token",
    "bootstrapToken",
    "tokenHash",
    "setupUrl",
    "reality_private_key",
    "realityPrivateKey",
    "private_key",
    "privateKey",
    "uuid",
    "api_key",
    "apiKey",
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

export function redactSensitive(text: string): string {
    let out = text;
    out = out.replace(/\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_KEY|API_KEY|DATABASE_URL|REDIS_URL)[A-Z0-9_]*\s*[:=]\s*)[^\s&,'"\\}<>]+/gi, "$1<redacted>");
    out = out.replace(/\b(authorization:\s*bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi, "$1<redacted>");
    out = out.replace(/\b(cookie:\s*)[^\r\n]+/gi, "$1<redacted>");
    out = out.replace(/\b(set-cookie:\s*)[^\r\n]+/gi, "$1<redacted>");
    out = out.replace(/\b(mysql|mariadb|postgres|postgresql|redis):\/\/[^\s'"<>]+/gi, "$1://<redacted>");
    out = out.replace(
        /(https?:\/\/[^\s'"<>]+\/api\/v1\/subscription\/)[A-Za-z0-9_-]+/g,
        "$1<redacted>",
    );
    out = out.replace(
        /(\/api\/v1\/subscription\/)[A-Za-z0-9_-]+/g,
        "$1<redacted>",
    );
    out = out.replace(
        /(\/setup\/bootstrap\?token=)[A-Za-z0-9_-]+/g,
        "$1<redacted>",
    );
    for (const key of SECRET_QUERY_KEYS) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        out = out.replace(new RegExp(`([?&]${escaped}=)[^\\s&#'"<>]+`, "gi"), "$1<redacted>");
    }
    out = out.replace(
        /\bctbt_[A-Za-z0-9_-]{20,}\b/g,
        "ctbt_<redacted>",
    );
    out = out.replace(/\bbase64:[A-Za-z0-9+/=]{20,}\b/g, "base64:<redacted>");
    out = out.replace(
        /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g,
        "<uuid>",
    );

    for (const key of SECRET_ENV_KEYS) {
        out = out.replace(new RegExp(`\\b(${key})=([^\\s'"\\\\"]+)`, "g"), "$1=<redacted>");
        out = out.replace(new RegExp(`\\b(${key})='[^']*'`, "g"), "$1='<redacted>'");
        out = out.replace(new RegExp(`\\b(${key})="[^"]*"`, "g"), '$1="<redacted>"');
    }

    for (const key of SECRET_JSON_KEYS) {
        out = out.replace(new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`, "gi"), "$1<redacted>$2");
        out = out.replace(new RegExp(`('${key}'\\s*=>\\s*')[^']*(')`, "gi"), "$1<redacted>$2");
    }

    return out;
}
