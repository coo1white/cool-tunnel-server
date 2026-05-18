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
    try {
        const keyPair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
            "deriveBits",
        ])) as unknown as CryptoKeyPair;

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
    } catch (err) {
        if (!(err instanceof DOMException) || err.name !== "NotSupportedError") {
            throw err;
        }
        return generateRealityKeypairFallback();
    }
}

export function deriveRealityPublicKeyForTest(privateKey: Uint8Array): Uint8Array {
    return x25519(privateKey, BASEPOINT);
}

function generateRealityKeypairFallback(): {
    privateKeyB64u: string;
    publicKeyB64u: string;
} {
    const privateKey = new Uint8Array(32);
    crypto.getRandomValues(privateKey);
    const publicKey = x25519(privateKey, BASEPOINT);
    return {
        privateKeyB64u: base64urlEncode(privateKey),
        publicKeyB64u: base64urlEncode(publicKey),
    };
}

const P = (1n << 255n) - 19n;
const BASEPOINT = new Uint8Array([9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

function x25519(scalar: Uint8Array, u: Uint8Array): Uint8Array {
    const k = new Uint8Array(scalar);
    k[0] &= 248;
    k[31] &= 127;
    k[31] |= 64;

    let x1 = decodeLittleEndian(u);
    x1 %= P;
    let x2 = 1n;
    let z2 = 0n;
    let x3 = x1;
    let z3 = 1n;
    let swap = 0;

    for (let t = 254; t >= 0; t--) {
        const kt = Number((BigInt(k[Math.floor(t / 8)] ?? 0) >> BigInt(t & 7)) & 1n);
        swap ^= kt;
        if (swap) {
            [x2, x3] = [x3, x2];
            [z2, z3] = [z3, z2];
        }
        swap = kt;

        const a = mod(x2 + z2);
        const aa = mod(a * a);
        const b = mod(x2 - z2);
        const bb = mod(b * b);
        const e = mod(aa - bb);
        const c = mod(x3 + z3);
        const d = mod(x3 - z3);
        const da = mod(d * a);
        const cb = mod(c * b);
        x3 = mod((da + cb) ** 2n);
        z3 = mod(x1 * mod((da - cb) ** 2n));
        x2 = mod(aa * bb);
        z2 = mod(e * mod(aa + 121665n * e));
    }

    if (swap) {
        [x2, x3] = [x3, x2];
        [z2, z3] = [z3, z2];
    }
    return encodeLittleEndian(mod(x2 * modPow(z2, P - 2n)));
}

function decodeLittleEndian(bytes: Uint8Array): bigint {
    let value = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
        value = (value << 8n) + BigInt(bytes[i] ?? 0);
    }
    return value;
}

function encodeLittleEndian(value: bigint): Uint8Array {
    const out = new Uint8Array(32);
    let n = mod(value);
    for (let i = 0; i < out.length; i++) {
        out[i] = Number(n & 255n);
        n >>= 8n;
    }
    return out;
}

function mod(n: bigint): bigint {
    const result = n % P;
    return result >= 0n ? result : result + P;
}

function modPow(base: bigint, exponent: bigint): bigint {
    let result = 1n;
    let b = mod(base);
    let e = exponent;
    while (e > 0n) {
        if (e & 1n) result = mod(result * b);
        b = mod(b * b);
        e >>= 1n;
    }
    return result;
}
