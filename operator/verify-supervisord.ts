#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/verify-supervisord.ts — pure-TS port of
// scripts/verify_supervisord.sh.
//
// Pin the round-6 lifecycle invariants on
// docker/panel/supervisord.conf. Every [program:*] block must carry
// the four uniform attributes:
//
//   stopsignal   = TERM
//   stopwaitsecs = 20
//   killasgroup  = true
//   stopasgroup  = true
//
// Plus per-program literals (frankenphp carries MAX_REQUESTS=500).
//
// Run from `make verify-supervisord` and the `make ci` gate.
//
// Behaviour notes preserved from the bash original:
//   - new [program:*] blocks are discovered automatically (no list
//     to maintain); the messenger program joined v0.0.93 and is
//     picked up here without code change.
//   - exits 1 if the conf is missing, has no [program:*] blocks,
//     or any required attribute is absent.
//   - exits 0 with a one-line "intact" message when all invariants
//     hold.

interface RequiredAttr {
    // Regex of the attribute line (without anchors) — matches the
    // bash original's `^[[:space:]]*<re>[[:space:]]*$` envelope.
    readonly re: RegExp;
    readonly label: string;
}

interface ProgramSpecificAttr {
    readonly program: string;
    readonly literal: string;
}

export interface VerifyOptions {
    readonly required: readonly RequiredAttr[];
    readonly programSpecific: readonly ProgramSpecificAttr[];
}

export const DEFAULT_OPTIONS: VerifyOptions = {
    required: [
        { re: /stopsignal\s*=\s*TERM/, label: "stopsignal = TERM" },
        { re: /stopwaitsecs\s*=\s*20/, label: "stopwaitsecs = 20" },
        { re: /killasgroup\s*=\s*true/, label: "killasgroup = true" },
        { re: /stopasgroup\s*=\s*true/, label: "stopasgroup = true" },
    ],
    programSpecific: [{ program: "frankenphp", literal: "MAX_REQUESTS=500" }],
};

export interface VerifyResult {
    readonly programs: readonly string[];
    readonly failures: readonly string[];
}

// Pure validator: parse the supervisord.conf body and return the
// list of [program:*] names plus any drift failures. No I/O.
export function verify(conf: string, opts: VerifyOptions = DEFAULT_OPTIONS): VerifyResult {
    const lines = conf.split("\n");
    const programs: string[] = [];
    const blocks = new Map<string, string[]>();

    let currentProgram: string | null = null;
    for (const line of lines) {
        const progM = line.match(/^\[program:([^\]]+)\]\s*$/);
        if (progM) {
            currentProgram = progM[1]!;
            programs.push(currentProgram);
            blocks.set(currentProgram, []);
            continue;
        }
        // Any other [section] header ends the current program block.
        if (/^\[/.test(line)) {
            currentProgram = null;
            continue;
        }
        if (currentProgram) blocks.get(currentProgram)!.push(line);
    }

    const failures: string[] = [];
    for (const prog of programs) {
        const body = (blocks.get(prog) ?? []).join("\n");
        for (const attr of opts.required) {
            // The bash original anchors the regex to a whole line
            // (`^\s*<re>\s*$`). Match line-by-line here for parity.
            const found = body.split("\n").some((l) => attr.re.test(l) && /^\s*[^#]/.test(l));
            if (!found) {
                failures.push(`[${prog}] missing required attribute: ${attr.label}`);
            }
        }
        for (const psa of opts.programSpecific) {
            if (psa.program !== prog) continue;
            if (!body.includes(psa.literal)) {
                failures.push(`[${prog}] missing program-specific attribute: ${psa.literal}`);
            }
        }
    }
    return { programs, failures };
}

async function main(): Promise<number> {
    // The script is run from the repo root via `make verify-supervisord`
    // (which does `cd operator && bun run ...`); resolve the conf
    // relative to this file so cwd doesn't matter.
    const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const confPath = `${repoRoot}/docker/panel/supervisord.conf`;
    const f = Bun.file(confPath);
    if (!(await f.exists())) {
        console.error(`verify_supervisord: ${confPath} not found`);
        return 1;
    }
    const result = verify(await f.text());
    if (result.programs.length === 0) {
        console.error(`verify_supervisord: no [program:*] blocks found in ${confPath}`);
        return 1;
    }
    console.log(
        `verify_supervisord: ${result.programs.length} programs found — ${result.programs.join(" ")}`,
    );
    if (result.failures.length > 0) {
        for (const f of result.failures) console.error(`  ✗ ${f}`);
        console.error(`
verify_supervisord: lifecycle invariants drift detected.
The round-6 ops audit pinned these so that \`docker compose stop\`
drains in-flight requests cleanly instead of being SIGKILL'd by
the cgroup. Restore the missing attribute(s), or — if you
intentionally changed the policy — update this script.`);
        return 1;
    }
    console.log("verify_supervisord: all lifecycle invariants intact");
    return 0;
}

// Only run main() when invoked as a script (not when imported by a
// unit test). Bun's `import.meta.main` is true for the entry module.
if (import.meta.main) {
    const code = await main();
    process.exit(code);
}
