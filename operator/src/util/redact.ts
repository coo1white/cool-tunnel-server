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
    "SESSION_COOKIE",
];

const SECRET_JSON_KEYS = [
    "password",
    "token",
    "subscription_secret",
    "reality_private_key",
    "private_key",
    "uuid",
];

export function redactSensitive(text: string): string {
    let out = text;
    out = out.replace(
        /(https?:\/\/[^\s'"<>]+\/api\/v1\/subscription\/)[A-Za-z0-9_-]+/g,
        "$1<redacted>",
    );
    out = out.replace(
        /(\/api\/v1\/subscription\/)[A-Za-z0-9_-]+/g,
        "$1<redacted>",
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
