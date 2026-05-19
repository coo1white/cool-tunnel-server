// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/prompt.ts — interactive prompt helpers.
//
// Mirrors scripts/lib.sh::prompt_yn and prompt_secret. Non-
// interactive (stdin not a TTY) falls back to the supplied default
// — same behaviour as the bash original so cron / CI runs don't
// hang on the prompt.
//
// Pure parsers (parseYn, parseChoice) are exported separately so
// unit tests don't need a real terminal.

import { createInterface, type Interface } from "node:readline";

// Pure: turn an arbitrary reply string into yes/no/<retry>. The
// bash original accepts y/Y/yes/YES and n/N/no/NO; everything
// else is a retry.
export function parseYn(reply: string, defaultAnswer: "y" | "n"): "yes" | "no" | "retry" {
    const r = reply.trim() === "" ? defaultAnswer : reply.trim();
    switch (r.toLowerCase()) {
        case "y":
        case "yes":
            return "yes";
        case "n":
        case "no":
            return "no";
        default:
            return "retry";
    }
}

// Pure: parse a choice key. The caller provides the allowed keys
// (single characters); the reply is lowercased before compare.
// Returns the matched key or null on miss.
export function parseChoice(reply: string, allowed: readonly string[], fallback: string | null = null): string | null {
    const r = reply.trim();
    if (r === "" && fallback) return fallback;
    const lower = r.toLowerCase();
    for (const k of allowed) {
        if (k.toLowerCase() === lower) return k;
    }
    return null;
}

function stdinIsTty(): boolean {
    return process.stdin.isTTY === true;
}

async function readLineFrom(rl: Interface): Promise<string> {
    return new Promise<string>((resolve) => {
        rl.question("", (answer) => resolve(answer));
    });
}

// promptYn(question, default) — same shape as scripts/lib.sh.
// Returns true for yes, false for no.
export async function promptYn(question: string, defaultAnswer: "y" | "n" = "n"): Promise<boolean> {
    if (!stdinIsTty()) {
        process.stderr.write(`    (non-interactive: defaulting to '${defaultAnswer}')\n`);
        return defaultAnswer === "y";
    }
    const hint = defaultAnswer === "y" ? "[Y/n]" : "[y/N]";
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        for (;;) {
            process.stderr.write(`\n    ? ${question} ${hint} `);
            const reply = await readLineFrom(rl);
            const r = parseYn(reply, defaultAnswer);
            if (r === "yes") return true;
            if (r === "no") return false;
            process.stderr.write("    please answer y or n\n");
        }
    } finally {
        rl.close();
    }
}

// promptChoice(prompt, allowedKeys, fallback?) — single-character
// pick. Returns the chosen key. Re-prompts on miss; non-
// interactive returns the fallback (or null if no fallback).
export async function promptChoice(
    promptLines: readonly string[],
    promptSuffix: string,
    allowed: readonly string[],
    fallback: string | null = null,
): Promise<string | null> {
    if (!stdinIsTty()) {
        if (fallback) {
            process.stderr.write(`    (non-interactive: defaulting to '${fallback}')\n`);
            return fallback;
        }
        return null;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        for (;;) {
            for (const line of promptLines) process.stderr.write(`${line}\n`);
            process.stderr.write(promptSuffix);
            const reply = await readLineFrom(rl);
            const k = parseChoice(reply, allowed, fallback);
            if (k !== null) return k;
            const allowedList = allowed.join(", ");
            process.stderr.write(`    please answer ${allowedList}\n`);
        }
    } finally {
        rl.close();
    }
}
