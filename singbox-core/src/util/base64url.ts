// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/src/util/base64url.ts — URL-safe base64 (RFC 4648 §5).
//
// Reality uses base64url without padding for X25519 keys.

export function base64urlEncode(bytes: Uint8Array): string {
    // Standard base64 from Bun then strip padding and rewrite alphabet.
    const b64 = Buffer.from(bytes).toString("base64");
    return b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64urlDecode(s: string): Uint8Array {
    const padded = s.replaceAll("-", "+").replaceAll("_", "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    return new Uint8Array(Buffer.from(padded + pad, "base64"));
}
