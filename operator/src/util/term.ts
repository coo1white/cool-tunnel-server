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

export interface ArrowProgress {
    advance(msg: string): void;
    pulse(msg?: string): void;
    complete(msg?: string): void;
    fail(msg?: string): void;
}

type ProgressStream = {
    readonly isTTY?: boolean;
    readonly columns?: number;
    readonly rows?: number;
    write(s: string): void;
};

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

export function formatArrowProgress(input: {
    readonly current: number;
    readonly total: number;
    readonly msg: string;
    readonly width: number;
    readonly failed?: boolean;
}): string {
    const total = Math.max(1, input.total);
    const current = Math.min(Math.max(0, input.current), total);
    const pct = Math.min(100, Math.max(0, Math.round((current / total) * 100)));
    const reserved = ` ct update ${pct}% ${current}/${total}  `.length;
    const barWidth = Math.max(10, Math.min(40, input.width - reserved - 4));
    const filled = Math.min(barWidth, Math.max(0, Math.round((pct / 100) * barWidth)));
    const arrows = ">".repeat(filled);
    const rest = "-".repeat(Math.max(0, barWidth - filled));
    const raw = `ct update [${arrows}${rest}] ${pct}% ${current}/${total}  ${input.msg}`;
    const max = Math.max(20, input.width - 1);
    return raw.length > max ? raw.slice(0, max - 1) + "…" : raw;
}

export function makeArrowProgress(opts: {
    readonly total: number;
    readonly stream?: ProgressStream;
    readonly enabled?: boolean;
}): ArrowProgress {
    const stream = opts.stream ?? process.stdout;
    const total = Math.max(1, opts.total);
    const enabled = opts.enabled ?? process.env["CT_PROGRESS_BAR"] !== "0";
    const tty = enabled && stream.isTTY === true;
    let current = 0;
    let lastMsg = "starting";

    const render = (msg = lastMsg, failed = false) => {
        if (!enabled) return;
        lastMsg = msg;
        const width = Math.max(40, stream.columns ?? 100);
        const line = formatArrowProgress({ current, total, msg, width, failed });
        if (!tty) {
            stream.write(`${failed ? "!" : "==>"} ${line}\n`);
            return;
        }
        const row = Math.max(1, stream.rows ?? 1);
        const color = failed ? ANSI.red : current >= total ? ANSI.green : ANSI.yellow;
        stream.write(`\x1b7\x1b[${row};1H\x1b[2K${color}${line}${ANSI.reset}\x1b8`);
    };

    return {
        advance(msg: string) {
            current = Math.min(total, current + 1);
            render(msg);
        },
        pulse(msg?: string) {
            render(msg ?? lastMsg);
        },
        complete(msg = "complete") {
            current = total;
            render(msg);
            if (tty) stream.write("\n");
        },
        fail(msg = "failed") {
            render(msg, true);
            if (tty) stream.write("\n");
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
