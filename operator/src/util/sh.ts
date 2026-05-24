// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/sh.ts — thin wrapper around Bun.$ that yields structured results.
//
// Two patterns:
//   capture()    — run a Bun shell expression and always return { ok, code, stdout, stderr }
//   ShellError   — thrown by callers who want exception-style control flow
//   which()      — cached PATH probe

import { $ } from "bun";
import { redactSensitive } from "./redact";

export class ShellError extends Error {
    constructor(
        readonly cmdLabel: string,
        readonly code: number,
        readonly stdout: string,
        readonly stderr: string,
    ) {
        super(`shell failed (${code}): ${cmdLabel}\n${redactSensitive(stderr).slice(0, 2000)}`);
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

// Live-streaming counterpart to capture() — pipes stdout AND stderr
// to the operator's terminal in real time, returns only the exit
// code. Use for long-running operations where the operator needs
// to see progress (docker build, db migrate, etc.); the v0.1.13
// Bun port wrapped these in capture() which buffered everything
// until subprocess exit, making a 2-minute `docker compose build`
// look like the script was stuck. Reported 2026-05-15 on the
// v0.1.16 Vultr update.
//
// Trade-off: no captured stdout/stderr strings, so the caller's
// error path can only show a generic diag (which is what the
// build callers already do — they don't reference r.stdout).
export async function runStreaming(p: ReturnType<typeof $>): Promise<{ ok: boolean; code: number }> {
    const r = await p.nothrow();
    return { ok: r.exitCode === 0, code: r.exitCode };
}

const whichCache = new Map<string, boolean>();
// Bun.which() is the right primitive — it walks PATH directly without
// spawning a subprocess. v0.1.5's `command -v <bin>` approach was broken
// because `command` is a shell builtin (not an executable on PATH), so
// Bun.$ (which execs directly without a shell) couldn't find it, and
// every which() call returned false. The live VPS run at v0.1.4 lit up
// every "<tool> not on PATH" warn as a false positive — fixing this
// single primitive flips most doctor checks back to their real state.
export async function which(bin: string): Promise<boolean> {
    const cached = whichCache.get(bin);
    if (cached !== undefined) return cached;
    const found = Bun.which(bin) !== null;
    whichCache.set(bin, found);
    return found;
}

export { $ };
