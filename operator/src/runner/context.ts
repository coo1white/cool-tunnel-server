// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/runner/context.ts — shared run context (cwd, env, logger, flags).

export interface Logger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
}

export interface RunContext {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly logger: Logger;
    readonly json: boolean;      // emit structured JSON to stdout
    readonly interactive: boolean;
}

// All log output goes to stderr so stdout stays clean for --json mode.
export function createConsoleLogger(): Logger {
    const debugEnabled = !!process.env["CT_OPERATOR_DEBUG"];
    return {
        info: (m) => process.stderr.write(m + "\n"),
        warn: (m) => process.stderr.write("warn: " + m + "\n"),
        error: (m) => process.stderr.write("error: " + m + "\n"),
        debug: (m) => {
            if (debugEnabled) process.stderr.write("debug: " + m + "\n");
        },
    };
}
