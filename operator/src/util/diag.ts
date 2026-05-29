// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/diag.ts — die_with_diag equivalent.
//
// Mirrors scripts/lib.sh::die_with_diag: print a red "✗ FAILED"
// line, an indented Diagnostic: block, then exit 1. Separated from
// term.ts because the diagnostic envelope is bigger (multi-line
// body, indentation) and only update / restore / install need it.

import { ANSI } from "./term";
import { redactSensitive } from "./redact";

export interface DiagFailure {
    readonly summary: string;
    readonly diag: string;
}

// Print a "✗ FAILED <summary>" block + indented Diagnostic body
// to stderr, then exit 1. Returns `never` so TS narrows control
// flow after the call.
export function dieWithDiag(summary: string, diag: string): never {
    process.stderr.write(`\n${ANSI.red}${ANSI.bold}✗ FAILED${ANSI.reset} ${redactSensitive(summary)}\n`);
    if (diag) {
        process.stderr.write(`\n${ANSI.bold}Diagnostic:${ANSI.reset}\n`);
        for (const line of redactSensitive(diag).split("\n")) {
            process.stderr.write(`  ${line}\n`);
        }
        process.stderr.write("\n");
    }
    process.exit(1);
}
