// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/src/util/sha256.ts — hex-encoded SHA-256 (WebCrypto).

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array | string): Promise<string> {
  const buf =
    typeof bytes === "string"
      ? new TextEncoder().encode(bytes)
      : bytes instanceof Uint8Array
        ? bytes
        : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(buf));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
