// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/crypto.test.ts — SHA-256 + ed25519 verify roundtrip.

import { test, expect } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { sha256, verifyEd25519 } from "../src/util/crypto";

test("sha256 returns the canonical hex digest of 'hello'", () => {
    const out = sha256(new TextEncoder().encode("hello"));
    expect(out).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});

test("sha256 produces 64 hex chars for arbitrary input", () => {
    const out = sha256(new TextEncoder().encode("the quick brown fox"));
    expect(out).toMatch(/^[a-f0-9]{64}$/);
});

test("verifyEd25519 accepts a real signature", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const message = new TextEncoder().encode("test SHA256SUMS content\nabc  ct-operator-linux-x64\n");
    const signature = sign(null, message, privateKey);

    const der = publicKey.export({ type: "spki", format: "der" });
    const raw = der.subarray(der.length - 32);
    const b64 = Buffer.from(raw).toString("base64");

    expect(verifyEd25519(b64, message, new Uint8Array(signature))).toBe(true);
});

test("verifyEd25519 rejects a tampered message", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const message = new TextEncoder().encode("original");
    const signature = sign(null, message, privateKey);

    const der = publicKey.export({ type: "spki", format: "der" });
    const raw = der.subarray(der.length - 32);
    const b64 = Buffer.from(raw).toString("base64");

    const tampered = new TextEncoder().encode("tampered");
    expect(verifyEd25519(b64, tampered, new Uint8Array(signature))).toBe(false);
});

test("verifyEd25519 rejects a foreign key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const { publicKey: otherPubkey } = generateKeyPairSync("ed25519");
    const message = new TextEncoder().encode("hello");
    const signature = sign(null, message, privateKey);

    const der = otherPubkey.export({ type: "spki", format: "der" });
    const raw = der.subarray(der.length - 32);
    const b64 = Buffer.from(raw).toString("base64");

    expect(verifyEd25519(b64, message, new Uint8Array(signature))).toBe(false);
});

test("verifyEd25519 rejects a malformed pubkey gracefully", () => {
    expect(verifyEd25519("not-a-real-base64-key", new Uint8Array(0), new Uint8Array(0))).toBe(false);
});
