// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/credential-sync.ts — credential-lock audit
// and auto-correct logic, shared between the `ct-operator
// auto-sync` task and the `credential_drift` fix recipe.
//
// Ported from scripts/auto_sync.sh. The bash original wraps three
// docker compose exec calls:
//
//   1. ct-server-core guard credential-lock   (audit)
//   2. if NG → ct-server-core --json singbox render   (correct)
//   3. docker compose restart sing-box        (apply)
//   4. brief settle, re-audit                  (re-verify)
//
// Exposed as a function (with a logger callback) so the recipe
// and the standalone task can share the implementation.

import { $, capture, which } from "./sh";

export interface SyncLogger {
    info(line: string): void;
    err(line: string): void;
    // Multi-line passthrough for indented output (compose error
    // dumps). Receives the raw text (caller indents). Optional so
    // existing callers without it stay valid.
    raw?(text: string): void;
}

export interface SyncResult {
    readonly ok: boolean;
    // "clean"     — no drift on the initial audit
    // "corrected" — drift detected, render + restart succeeded, re-audit passed
    // "render_failed" — drift detected but the singbox render call failed
    // "restart_failed" — render succeeded but `compose restart sing-box` failed
    // "still_drifted" — corrective action ran but re-audit still NG
    // "no_docker" — docker not on PATH; nothing to do
    readonly outcome:
        | "clean"
        | "corrected"
        | "render_failed"
        | "restart_failed"
        | "still_drifted"
        | "no_docker";
    readonly detail?: string;
}

const SETTLE_MS = 5000;

function stamp(): string {
    return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function makePrefix(logger: SyncLogger, level: "info" | "err"): (msg: string) => void {
    const fn = level === "info" ? logger.info.bind(logger) : logger.err.bind(logger);
    return (msg) => fn(`[${stamp()}] auto-sync: ${msg}`);
}

// Bash original's `sed 's/^/    /'` equivalent — indent every line
// of a captured output block by 4 spaces. The raw() callback (or
// info() as a fallback) receives the indented multi-line text.
// Exported for tests.
export function dumpIndented(logger: SyncLogger, text: string): void {
    const indented = text
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => `    ${l}`)
        .join("\n");
    if (!indented) return;
    if (logger.raw) {
        logger.raw(indented);
    } else {
        for (const line of indented.split("\n")) logger.info(line);
    }
}

// Run the audit-and-correct cycle. Returns a structured result;
// callers decide how to render it. Honors `dryRun` by short-
// circuiting after the initial audit.
export async function runCredentialSync(opts: {
    readonly logger: SyncLogger;
    readonly dryRun?: boolean;
}): Promise<SyncResult> {
    const say = makePrefix(opts.logger, "info");
    const err = makePrefix(opts.logger, "err");

    if (!(await which("docker"))) {
        err("docker not on PATH — cannot run credential-lock audit");
        return { ok: false, outcome: "no_docker" };
    }

    // ---------- 1. Initial audit ----------
    const audit = await capture(
        $`docker compose exec -T panel ct-server-core guard credential-lock`,
    );
    if (audit.ok) {
        const head = (audit.stdout.replace(/\n/g, " ") || "ok").slice(0, 200);
        say(`no drift detected — ${head}`);
        return { ok: true, outcome: "clean", detail: head };
    }

    say("DRIFT DETECTED — credential-lock guard reported:");
    dumpIndented(opts.logger, audit.stdout + audit.stderr);

    if (opts.dryRun) {
        say("(dry-run) would now: re-render sing-box + restart container");
        return { ok: false, outcome: "still_drifted", detail: "dry-run; no action taken" };
    }

    // ---------- 2. Re-render sing-box config ----------
    say("attempting corrective action — re-rendering sing-box config");
    const render = await capture(
        $`docker compose exec -T panel ct-server-core --json singbox render`,
    );
    if (!render.ok) {
        err("FAILED to re-render sing-box config:");
        dumpIndented(
            { info: opts.logger.err, err: opts.logger.err, raw: opts.logger.raw },
            render.stdout + render.stderr,
        );
        return {
            ok: false,
            outcome: "render_failed",
            detail: render.stderr.split("\n")[0] || `render exit ${render.code}`,
        };
    }
    const renderHead = (render.stdout.replace(/\n/g, " ") || "ok").slice(0, 200);
    say(`render output: ${renderHead}`);

    // ---------- 3. Restart sing-box ----------
    say("restarting sing-box container so the new config takes effect");
    const restart = await capture($`docker compose restart sing-box`);
    if (!restart.ok) {
        err("FAILED to restart sing-box container");
        return {
            ok: false,
            outcome: "restart_failed",
            detail: restart.stderr.split("\n")[0] || `restart exit ${restart.code}`,
        };
    }

    // Brief settle window before re-verification. sing-box restart
    // is fast (typically <2s) but the naive inbound takes a moment
    // to bind. Less than 5s is risky on a 1-vCPU box under load.
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // ---------- 4. Re-verify ----------
    const reaudit = await capture(
        $`docker compose exec -T panel ct-server-core guard credential-lock`,
    );
    if (reaudit.ok) {
        const head = (reaudit.stdout.replace(/\n/g, " ") || "ok").slice(0, 200);
        say(`CORRECTED — credential-lock now reports OK: ${head}`);
        say("auto-sync action complete. Drift was caught + resolved.");
        return { ok: true, outcome: "corrected", detail: head };
    }
    err("STILL DRIFT after correction — credential-lock guard still reports:");
    dumpIndented(
        { info: opts.logger.err, err: opts.logger.err, raw: opts.logger.raw },
        reaudit.stdout + reaudit.stderr,
    );
    err("manual investigation required. Most likely causes:");
    err("  - panel container can't decrypt password_cleartext_encrypted (APP_KEY rotation?)");
    err("  - sing-box config volume has different mount than the renderer writes to");
    err("  - a writer (Filament UI?) is mutating the row between render and verify");
    err("  - the sing-box restart did not pick up the new config (check container logs)");
    return {
        ok: false,
        outcome: "still_drifted",
        detail: (reaudit.stdout + reaudit.stderr).split("\n")[0] || "guard still NG after correction",
    };
}
