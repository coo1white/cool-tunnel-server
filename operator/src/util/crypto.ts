// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/crypto.ts — SHA-256 + ed25519 signature verification.
//
// Pubkey embedding: BUILD_PUBKEY (set at build time) holds the 32-byte
// raw ed25519 public key, base64-encoded. We wrap it in the standard
// SPKI DER prefix at runtime so node:crypto can consume it.

import { createPublicKey, createHash, verify, type KeyObject } from "node:crypto";

// SPKI DER prefix for ed25519 (RFC 8410 §4):
//   SEQUENCE (0x30) length 0x2A
//     SEQUENCE (0x30) length 0x05
//       OID id-Ed25519 (06 03 2B 65 70)
//     BIT STRING (03 21 00) followed by 32 raw key bytes
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function sha256(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
    const f = Bun.file(path);
    const bytes = new Uint8Array(await f.arrayBuffer());
    return sha256(bytes);
}

export function loadEd25519PubkeyFromRawBase64(b64: string): KeyObject {
    const raw = Buffer.from(b64, "base64");
    if (raw.length !== 32) {
        throw new Error(`expected 32-byte ed25519 pubkey, got ${raw.length} bytes`);
    }
    const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
    return createPublicKey({ key: der, format: "der", type: "spki" });
}

export function verifyEd25519(
    pubkeyB64: string,
    message: Uint8Array,
    signature: Uint8Array,
): boolean {
    try {
        const key = loadEd25519PubkeyFromRawBase64(pubkeyB64);
        return verify(null, message, key, signature);
    } catch {
        return false;
    }
}
