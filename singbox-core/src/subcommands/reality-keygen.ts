// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/src/subcommands/reality-keygen.ts — X25519 keypair generator.
//
// Reality requires an X25519 keypair: the server keeps the private key,
// the client embeds the public key. Generated ONCE on first server-side
// deploy; rotation requires re-issuing every active client's config.
//
// Output format (matches what sing-box and the Reality reference
// implementations emit):
//
//   {
//     "private_key": "<base64url, no padding>",
//     "public_key":  "<base64url, no padding>"
//   }
//
// Both are 32 bytes raw → 43 chars base64url.

import { base64urlEncode } from "../util/base64url.ts";

interface ParsedArgs {
    readonly json: boolean;
    readonly help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
    let json = false;
    let help = false;
    for (const a of argv) {
        if (a === "--json") json = true;
        else if (a === "--help" || a === "-h") help = true;
        else throw new Error(`unknown flag: ${a}`);
    }
    return { json, help };
}

function usage(): string {
    return [
        "Usage: singbox-core reality-keygen [--json]",
        "",
        "Generate a fresh X25519 keypair for Reality. The private key stays",
        "on the server (sing-box server config), the public key embeds in",
        "every client's config.",
        "",
        "  --json   Emit { private_key, public_key } to stdout (default).",
        "  (no flag) Pretty-print private_key/public_key as text lines.",
    ].join("\n");
}

export async function runRealityKeygen(argv: readonly string[]): Promise<number> {
    const args = parseArgs(argv);
    if (args.help) {
        process.stdout.write(usage() + "\n");
        return 0;
    }

    const { privateKeyB64u, publicKeyB64u } = await generateRealityKeypair();

    if (args.json) {
        process.stdout.write(
            JSON.stringify({ private_key: privateKeyB64u, public_key: publicKeyB64u }) + "\n",
        );
    } else {
        process.stdout.write(`private_key: ${privateKeyB64u}\n`);
        process.stdout.write(`public_key:  ${publicKeyB64u}\n`);
    }
    return 0;
}

/**
 * Generate an X25519 keypair via WebCrypto. Bun 1.1+ supports the
 * "X25519" algorithm in crypto.subtle via OpenSSL.
 *
 * Exported for unit tests.
 */
export async function generateRealityKeypair(): Promise<{
    privateKeyB64u: string;
    publicKeyB64u: string;
}> {
    const keyPair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
        "deriveBits",
    ])) as CryptoKeyPair;

    // Public key: 32 bytes raw (X25519 u-coordinate).
    const publicRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    const publicKeyB64u = base64urlEncode(new Uint8Array(publicRaw));

    // Private key: WebCrypto only exports as JWK or PKCS8 for private keys.
    // The JWK's `d` field is the raw 32-byte scalar in base64url — already
    // the format Reality wants.
    const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
    if (typeof privateJwk.d !== "string") {
        throw new Error("X25519 JWK export missing `d` field");
    }
    // JWK uses base64url-without-padding too — pass through.
    const privateKeyB64u = privateJwk.d.replace(/=+$/, "");

    return { privateKeyB64u, publicKeyB64u };
}
