// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/tests/reality-keygen.test.ts — X25519 keypair shape.

import { expect, test } from "bun:test";
import {
  deriveRealityPublicKeyForTest,
  generateRealityKeypair,
} from "../src/subcommands/reality-keygen.ts";
import { base64urlDecode } from "../src/util/base64url.ts";

test("generateRealityKeypair returns base64url-encoded 32-byte X25519 keys", async () => {
  const { privateKeyB64u, publicKeyB64u } = await generateRealityKeypair();

  // base64url-without-padding for 32 bytes = 43 chars
  expect(privateKeyB64u.length).toBe(43);
  expect(publicKeyB64u.length).toBe(43);
  expect(privateKeyB64u).not.toMatch(/[+/=]/);
  expect(publicKeyB64u).not.toMatch(/[+/=]/);

  // Decoding reveals 32 raw bytes for both
  const privateRaw = base64urlDecode(privateKeyB64u);
  const publicRaw = base64urlDecode(publicKeyB64u);
  expect(privateRaw.length).toBe(32);
  expect(publicRaw.length).toBe(32);
});

test("generateRealityKeypair produces unique keypairs per call", async () => {
  const a = await generateRealityKeypair();
  const b = await generateRealityKeypair();
  expect(a.privateKeyB64u).not.toBe(b.privateKeyB64u);
  expect(a.publicKeyB64u).not.toBe(b.publicKeyB64u);
});

test("deriveRealityPublicKeyForTest matches the RFC 7748 X25519 vector", () => {
  const privateKey = Buffer.from(
    "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
    "hex",
  );
  const publicKey = deriveRealityPublicKeyForTest(new Uint8Array(privateKey));
  expect(Buffer.from(publicKey).toString("hex")).toBe(
    "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
  );
});
