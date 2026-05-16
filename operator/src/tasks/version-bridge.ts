// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/version-bridge.ts — `ct-operator version-bridge`.
//
// Surface the version each runtime layer reports for the deployment.
// Three layers must agree for a healthy deploy: panel-config (PHP),
// rust-core (binary inside the panel container), operator-binary
// (this CLI). When they disagree the operator typically can't
// dispatch correctly: the wrapper invokes subcommands the binary
// doesn't have, or the panel renders configs the daemon can't load.
//
// Exit codes:
//   0  every readable layer agreed on the version
//   1  at least one layer disagreed
//   2  could not read any version (no panel/config, no binary, etc.)

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import {
    classifyBridge,
    classifyNaiveBridge,
    operatorBinaryVersion,
    readNaiveCanonical,
    readNaiveClientVersion,
    readNaiveServerVersion,
    readPanelConfigVersion,
    readRustCoreVersion,
    type BridgeReport,
    type LayerVersion,
} from "../util/version-bridge";

export class VersionBridgeTask implements Task {
    readonly name = "version-bridge";

    constructor(private readonly operatorVersion: string) {}

    async run(ctx: RunContext): Promise<TaskResult> {
        const [panelConfig, opBin, rustCore, naiveCanon, naiveSrv, naiveCli] = await Promise.all([
            readPanelConfigVersion(ctx.cwd),
            Promise.resolve(operatorBinaryVersion(this.operatorVersion)),
            readRustCoreVersion(),
            readNaiveCanonical(ctx.cwd),
            readNaiveServerVersion(),
            readNaiveClientVersion(),
        ]);
        const report = classifyBridge([panelConfig, opBin, rustCore]);
        // The naive bridge tracks the v0.3.0+ invariant that the
        // running server-side and client-side naive binaries match
        // each other AND the manifest pin. Separate canonical from
        // the ct-* report because the version-strings are unrelated
        // (ct-* lives in 0.x; naive lives in 14x.x).
        const naiveCanonLabel: LayerVersion = { ...naiveCanon, layer: "naive-server" };
        const naiveReport = classifyNaiveBridge(
            { ...naiveCanonLabel, source: naiveCanon.source + " [canonical]" },
            naiveSrv,
            naiveCli,
        );

        if (ctx.json) {
            process.stdout.write(JSON.stringify({ ct: report, naive: naiveReport }) + "\n");
            return mergedResult(report, naiveReport);
        }

        // Human-readable side-by-side table.
        const w1 = Math.max(...report.layers.map((l) => l.layer.length), "layer".length);
        const w2 = Math.max(
            ...report.layers.map((l) => (l.version ?? "?").length),
            "version".length,
        );
        process.stdout.write(
            `Cool Tunnel Server — cross-layer version bridge\n` +
                `  ${"layer".padEnd(w1)}  ${"version".padEnd(w2)}  source\n` +
                `  ${"-".repeat(w1)}  ${"-".repeat(w2)}  ${"-".repeat(20)}\n`,
        );
        for (const l of report.layers) {
            const marker = l.version === report.canonical ? " " : "!";
            const v = l.version ?? "?";
            process.stdout.write(
                ` ${marker}${l.layer.padEnd(w1)}  ${v.padEnd(w2)}  ${l.source}` +
                    (l.error ? `   (${l.error})` : "") +
                    `\n`,
            );
        }
        process.stdout.write("\n");
        if (report.agreed) {
            process.stdout.write(
                `✓ all readable layers agree on version ${report.canonical ?? "?"}\n`,
            );
        } else if (report.canonical === null) {
            process.stdout.write(`✗ could not read any layer's version\n`);
        } else {
            process.stdout.write(
                `✗ version skew detected; canonical = ${report.canonical}\n` +
                    `  Mismatched layers:\n`,
            );
            for (const l of report.mismatches) {
                process.stdout.write(`    ${l.layer} reports ${l.version}\n`);
            }
            process.stdout.write(
                `\n  Likely fix:\n` +
                    `    ./ct update                    # syncs operator binary + rebuilds containers\n` +
                    `    # or, if just the operator binary is stale:\n` +
                    `    make operator-fetch            # fetches the matching binary from GitHub Releases\n`,
            );
        }

        // Second table: naive server ↔ client lockstep.
        process.stdout.write(
            `\nNaive binary bridge (v0.3.0+ — server == client invariant)\n` +
                `  layer            version           source\n` +
                `  ---------------  ----------------  --------------------\n`,
        );
        for (const l of naiveReport.layers) {
            const marker = l.version === naiveReport.canonical ? " " : "!";
            const v = l.version ?? "?";
            process.stdout.write(
                ` ${marker}${l.layer.padEnd(15)}  ${v.padEnd(16)}  ${l.source}` +
                    (l.error ? `   (${l.error})` : "") +
                    `\n`,
            );
        }
        if (naiveReport.agreed) {
            process.stdout.write(
                `\n✓ server-side and client-side naive agree on ${naiveReport.canonical ?? "?"}\n`,
            );
        } else if (naiveReport.canonical === null) {
            process.stdout.write(`\n✗ could not read any naive layer\n`);
        } else {
            process.stdout.write(
                `\n✗ naive drift; canonical = ${naiveReport.canonical}\n` +
                    `  Mismatched layers:\n`,
            );
            for (const l of naiveReport.mismatches) {
                process.stdout.write(`    ${l.layer} reports ${l.version}\n`);
            }
            process.stdout.write(
                `\n  Likely fix:\n` +
                    `    make sync-naive-pin && ./ct update   # rebuild both containers in lockstep\n` +
                    `    # or, if the manifest itself is wrong:\n` +
                    `    $EDITOR manifests/naive.upstream.json # fix the canonical pin first\n`,
            );
        }

        return mergedResult(report, naiveReport);
    }
}

function reportToResult(report: BridgeReport, label: string): TaskResult {
    if (report.agreed) {
        return { ok: true, code: 0, summary: `${label}: all layers agree on ${report.canonical}` };
    }
    if (report.canonical === null) {
        return { ok: false, code: 2, summary: `${label}: no readable version layer` };
    }
    const m = report.mismatches.map((l) => `${l.layer}=${l.version}`).join(", ");
    return {
        ok: false,
        code: 1,
        summary: `${label} skew: canonical=${report.canonical} mismatched=[${m}]`,
        skipBridge: true,
    };
}

function mergedResult(ct: BridgeReport, naive: BridgeReport): TaskResult {
    const ctR = reportToResult(ct, "ct");
    const naiveR = reportToResult(naive, "naive");
    if (ctR.ok && naiveR.ok) {
        return { ok: true, code: 0, summary: `${ctR.summary}; ${naiveR.summary}` };
    }
    // Worst-of: ct drift (code 1) is more actionable than "could not
    // read" (code 2); the merged exit code is max(ctR.code, naiveR.code)
    // EXCEPT we prefer 1 (skew) over 2 (unreadable) because skew has a
    // remediation and unreadable usually means "stack isn't up".
    const code = ctR.code === 1 || naiveR.code === 1 ? 1 : Math.max(ctR.code, naiveR.code);
    const parts = [ctR, naiveR].filter((r) => !r.ok).map((r) => r.summary);
    return { ok: false, code, summary: parts.join("; "), skipBridge: true };
}
