// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/term.ts — shared terminal output helpers.
//
// Mirrors scripts/lib.sh's step / ok / warn / die formatting so
// Bun-side scripts produce visually-identical output to the bash
// originals. Each script gets its own step counter via `make()`.
//
// Used by operator/pin-images.ts, operator/sbom.ts, and any future
// script-style port that wants the green-arrow "==>" step header.

const isTty = process.stdout.isTTY === true;

export const ANSI = {
    bold: isTty ? "\x1b[1m" : "",
    green: isTty ? "\x1b[32m" : "",
    yellow: isTty ? "\x1b[33m" : "",
    red: isTty ? "\x1b[31m" : "",
    reset: isTty ? "\x1b[0m" : "",
} as const;

export interface Term {
    step(msg: string): void;
    ok(msg: string): void;
    warn(msg: string): void;
}

// Create a fresh terminal helper with its own step counter.
// Splitting state into a factory (rather than module-level
// `let stepNum = 0`) means two consumers in the same process —
// e.g. a unit test importing the same module twice — don't share
// the counter.
export function makeTerm(opts?: { initialStep?: number }): Term {
    let stepNum = opts?.initialStep ?? 0;
    return {
        step(msg: string) {
            stepNum++;
            console.log(
                `\n${ANSI.bold}${ANSI.green}==>${ANSI.reset} ${ANSI.bold}${stepNum}.${ANSI.reset} ${msg}`,
            );
        },
        ok(msg: string) {
            console.log(`    ${ANSI.green}✓${ANSI.reset} ${msg}`);
        },
        warn(msg: string) {
            console.error(`    ${ANSI.yellow}!${ANSI.reset} ${msg}`);
        },
    };
}

// die() is a module-level function (not a Term method) so TS picks
// up its `never` return type for control-flow narrowing. Method
// calls on an interface — `term.die(...)` — don't always trigger
// the same narrowing in TS's analyser, so importers get the
// narrowing-friendly version by importing the named export.
export function die(msg: string, hint?: string): never {
    console.error(`\n${ANSI.red}${ANSI.bold}✗ FAILED${ANSI.reset} ${msg}`);
    if (hint) console.error(`  ${ANSI.bold}↳ try:${ANSI.reset} ${hint}`);
    process.exit(1);
}
