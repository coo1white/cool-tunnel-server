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
    operatorBinaryVersion,
    readPanelConfigVersion,
    readRustCoreVersion,
    type BridgeReport,
} from "../util/version-bridge";

export class VersionBridgeTask implements Task {
    readonly name = "version-bridge";

    constructor(private readonly operatorVersion: string) {}

    async run(ctx: RunContext): Promise<TaskResult> {
        const layers = await Promise.all([
            readPanelConfigVersion(ctx.cwd),
            Promise.resolve(operatorBinaryVersion(this.operatorVersion)),
            readRustCoreVersion(),
        ]);
        const report = classifyBridge(layers);

        if (ctx.json) {
            process.stdout.write(JSON.stringify(report) + "\n");
            return reportToResult(report);
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

        return reportToResult(report);
    }
}

function reportToResult(report: BridgeReport): TaskResult {
    if (report.agreed) {
        return { ok: true, code: 0, summary: `all layers agree on ${report.canonical}` };
    }
    if (report.canonical === null) {
        return { ok: false, code: 2, summary: "no readable version layer" };
    }
    const m = report.mismatches.map((l) => `${l.layer}=${l.version}`).join(", ");
    return {
        ok: false,
        code: 1,
        summary: `version skew: canonical=${report.canonical} mismatched=[${m}]`,
        skipBridge: true,
    };
}
