// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/sh.ts — thin wrapper around Bun.$ that yields structured results.
//
// Two patterns:
//   capture()    — run a Bun shell expression and always return { ok, code, stdout, stderr }
//   ShellError   — thrown by callers who want exception-style control flow
//   which()      — cached PATH probe

import { $ } from "bun";

export class ShellError extends Error {
    constructor(
        readonly cmdLabel: string,
        readonly code: number,
        readonly stdout: string,
        readonly stderr: string,
    ) {
        super(`shell failed (${code}): ${cmdLabel}\n${stderr.slice(0, 2000)}`);
        this.name = "ShellError";
    }
}

export type ShResult = {
    ok: boolean;
    code: number;
    stdout: string;
    stderr: string;
};

// Resolve a Bun shell promise without throwing on non-zero exit.
//
// Usage:
//   const r = await capture($`docker compose ps panel --status running`);
//   if (!r.ok) handle(...);
export async function capture(p: ReturnType<typeof $>): Promise<ShResult> {
    const r = await p.nothrow().quiet();
    return {
        ok: r.exitCode === 0,
        code: r.exitCode,
        stdout: r.stdout.toString(),
        stderr: r.stderr.toString(),
    };
}

const whichCache = new Map<string, boolean>();
// Bun.which() is the right primitive — it walks PATH directly without
// spawning a subprocess. v0.1.5's `command -v <bin>` approach was broken
// because `command` is a shell builtin (not an executable on PATH), so
// Bun.$ (which execs directly without a shell) couldn't find it, and
// every which() call returned false. The live VPS run at v0.1.4 lit up
// every "<tool> not on PATH" warn as a false positive — fixing this
// single primitive flips most ballast checks back to their real state.
export async function which(bin: string): Promise<boolean> {
    const cached = whichCache.get(bin);
    if (cached !== undefined) return cached;
    const found = Bun.which(bin) !== null;
    whichCache.set(bin, found);
    return found;
}

export { $ };
