#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/src/cli.ts — single binary entry point.
//
// Dispatches to one of:
//   singbox-core version
//   singbox-core render-server  --input <path>  [--output <path>]
//   singbox-core render-client  --input <path>  [--output <path>]
//   singbox-core supervise      --config <path>
//   singbox-core install        [--target-dir <path>]
//   singbox-core reality-keygen
//
// Subcommands are implemented in src/subcommands/ — this file only
// dispatches.

import { runRenderServer } from "./subcommands/render-server.ts";
import { runVersion } from "./subcommands/version.ts";

type SubcommandRunner = (argv: readonly string[]) => Promise<number> | number;

const SUBCOMMANDS: Record<string, SubcommandRunner> = {
    version: runVersion,
    "render-server": runRenderServer,
    // The remaining subcommands are stubbed for v0.4.0-alpha.0 and
    // will land in subsequent commits. Keep the names registered so
    // operators get a useful "not yet implemented" error rather than
    // "unknown subcommand".
    "render-client": stub("render-client"),
    supervise: stub("supervise"),
    install: stub("install"),
    "reality-keygen": stub("reality-keygen"),
};

function stub(name: string): SubcommandRunner {
    return () => {
        console.error(`singbox-core ${name}: not yet implemented in v0.4.0-alpha.0`);
        return 64; // EX_USAGE
    };
}

function usage(): string {
    return [
        "Usage: singbox-core <subcommand> [options]",
        "",
        "Subcommands:",
        "  version                Print singbox-core + pinned sing-box version",
        "  render-server          Render sing-box server config.json from --input",
        "  render-client          Render sing-box client config.json from --input",
        "  supervise              Watch config + cert, spawn/respawn sing-box",
        "  install                Fetch + verify the pinned sing-box binary",
        "  reality-keygen         Generate a Reality X25519 keypair",
        "",
        "Use `singbox-core <subcommand> --help` for subcommand-specific options.",
    ].join("\n");
}

async function main(): Promise<number> {
    const [, , subcommand, ...rest] = process.argv;
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
        process.stdout.write(usage() + "\n");
        return subcommand ? 0 : 64;
    }
    const runner = SUBCOMMANDS[subcommand];
    if (!runner) {
        process.stderr.write(`singbox-core: unknown subcommand: ${subcommand}\n`);
        process.stderr.write(usage() + "\n");
        return 64;
    }
    try {
        return await runner(rest);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`singbox-core ${subcommand}: ${msg}\n`);
        return 1;
    }
}

const code = await main();
process.exit(code);
