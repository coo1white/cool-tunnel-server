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
export async function which(bin: string): Promise<boolean> {
    const cached = whichCache.get(bin);
    if (cached !== undefined) return cached;
    const r = await capture($`command -v ${bin}`);
    whichCache.set(bin, r.ok);
    return r.ok;
}

export { $ };
