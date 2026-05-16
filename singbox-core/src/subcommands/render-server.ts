// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/src/subcommands/render-server.ts
//
// Reads a ServerRenderInput JSON from stdin or --input file, calls
// renderServerConfig, writes the sing-box config.json to --output (or
// stdout if absent). Atomic write when --output is given.
//
// Schema of --input (matches ServerRenderInput in config/render.ts):
//
//   {
//     "domain": "naive.coolwhite.space",
//     "listen_port": 443,
//     "reality_private_key": "<X25519 base64url>",
//     "reality_short_ids": ["", "0123abcd"],
//     "reality_dest_host": "www.microsoft.com",
//     "reality_dest_port": 443,
//     "accounts": [{ "username": "test1", "uuid": "..." }],
//     "log_level": "info"
//   }

import { readFileSync } from "node:fs";
import { renderServerConfig, type ServerRenderInput } from "../config/render.ts";
import { atomicWrite } from "../util/atomic-write.ts";

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
        if (a === "--input" || a === "-i") {
            input = argv[++i];
        } else if (a === "--output" || a === "-o") {
            output = argv[++i];
        } else if (a === "--json") {
            json = true;
        } else if (a === "--help" || a === "-h") {
            help = true;
        } else {
            throw new Error(`unknown flag: ${a}`);
        }
    }
    return { input, output, json, help };
}

function usage(): string {
    return [
        "Usage: singbox-core render-server [--input <path>] [--output <path>] [--json]",
        "",
        "  --input/-i   Read ServerRenderInput JSON from this path (default: stdin).",
        "  --output/-o  Write rendered sing-box config.json atomically to this path",
        "               (default: stdout).",
        "  --json       Emit a render-outcome JSON line to stdout (path, bytes,",
        "               sha256, changed). Implies a non-stdout --output.",
    ].join("\n");
}

export async function runRenderServer(argv: readonly string[]): Promise<number> {
    const args = parseArgs(argv);
    if (args.help) {
        process.stdout.write(usage() + "\n");
        return 0;
    }

    const inputText = args.input ? readFileSync(args.input, "utf8") : await readStdin();
    const parsed = JSON.parse(inputText) as ServerRenderInput;
    const config = renderServerConfig(parsed);
    const body = JSON.stringify(config, null, 2) + "\n";

    if (!args.output) {
        process.stdout.write(body);
        return 0;
    }

    const previous = readIfExists(args.output);
    const changed = previous !== body;
    if (changed) {
        atomicWrite(args.output, body, 0o644);
    }

    if (args.json) {
        const hash = await sha256Hex(body);
        process.stdout.write(
            JSON.stringify({
                path: args.output,
                bytes: body.length,
                sha256: hash,
                changed,
                active_users: parsed.accounts.length,
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
    if (!body.trim()) {
        throw new Error("empty stdin — pass --input <path> or pipe JSON in");
    }
    return body;
}

function readIfExists(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}

async function sha256Hex(body: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
