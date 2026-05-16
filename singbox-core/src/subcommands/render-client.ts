// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/src/subcommands/render-client.ts
//
// Mirror of render-server for the client-side config. Used by the
// macOS app's TunnelOrchestrator (Swift) when it spawns singbox-core
// after the user picks a profile.
//
// Schema of --input (matches ClientRenderInput in config/render.ts):
//
//   {
//     "server_host": "naive.coolwhite.space",
//     "server_port": 443,
//     "uuid": "...",
//     "reality_public_key": "<base64url>",
//     "reality_short_id": "",
//     "reality_dest_host": "www.microsoft.com",
//     "socks_listen_host": "127.0.0.1",
//     "socks_listen_port": 1080,
//     "log_level": "info"
//   }

import { readFileSync } from "node:fs";
import { renderClientConfig, type ClientRenderInput } from "../config/render.ts";
import { atomicWrite } from "../util/atomic-write.ts";
import { sha256Hex } from "../util/sha256.ts";

interface ParsedArgs {
    readonly input?: string;
    readonly output?: string;
    readonly json: boolean;
    readonly help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
    let input: string | undefined;
    let output: string | undefined;
    let json = false;
    let help = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === "--input" || a === "-i") input = argv[++i];
        else if (a === "--output" || a === "-o") output = argv[++i];
        else if (a === "--json") json = true;
        else if (a === "--help" || a === "-h") help = true;
        else throw new Error(`unknown flag: ${a}`);
    }
    return { input, output, json, help };
}

function usage(): string {
    return [
        "Usage: singbox-core render-client [--input <path>] [--output <path>] [--json]",
        "",
        "  --input/-i   Read ClientRenderInput JSON (default: stdin)",
        "  --output/-o  Write rendered sing-box config.json atomically (default: stdout)",
        "  --json       Emit render-outcome JSON line (path, bytes, sha256, changed)",
    ].join("\n");
}

export async function runRenderClient(argv: readonly string[]): Promise<number> {
    const args = parseArgs(argv);
    if (args.help) {
        process.stdout.write(usage() + "\n");
        return 0;
    }

    const text = args.input ? readFileSync(args.input, "utf8") : await readStdin();
    const parsed = JSON.parse(text) as ClientRenderInput;
    const config = renderClientConfig(parsed);
    const body = JSON.stringify(config, null, 2) + "\n";

    if (!args.output) {
        process.stdout.write(body);
        return 0;
    }

    const previous = readIfExists(args.output);
    const changed = previous !== body;
    if (changed) atomicWrite(args.output, body, 0o600);

    if (args.json) {
        const hash = await sha256Hex(body);
        process.stdout.write(
            JSON.stringify({
                path: args.output,
                bytes: body.length,
                sha256: hash,
                changed,
            }) + "\n",
        );
    }
    return 0;
}

async function readStdin(): Promise<string> {
    let body = "";
    for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
        body += new TextDecoder().decode(chunk);
    }
    if (!body.trim()) throw new Error("empty stdin — pass --input <path> or pipe JSON in");
    return body;
}

function readIfExists(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}
