// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/version-bridge.ts — `ct-operator version-bridge`.
//
// Surface the version each runtime layer reports for the deployment.
// Three "ct-*" layers must agree for a healthy deploy: panel-config
// (PHP), rust-core (binary inside the panel container), and
// operator-binary (this CLI). Separately, the sing-box layer must
// match the pin in singbox-core/singbox.upstream.json (canonical for
// the running ct-singbox binary AND for the Cool Tunnel.app's
// embedded binary, after the coordinated v3.0.0 client cut).
//
// Exit codes:
//   0  every readable layer agreed
//   1  at least one layer disagreed
//   2  could not read any version (no panel/config, stack down, etc.)

import type { Task, TaskResult } from "../runner/task";
import type { RunContext } from "../runner/context";
import {
    classifyBridge,
    classifySingboxBridge,
    operatorBinaryVersion,
    readPanelConfigVersion,
    readRustCoreVersion,
    readSingboxCanonical,
    readSingboxServerVersion,
    type BridgeReport,
} from "../util/version-bridge";

export class VersionBridgeTask implements Task {
    readonly name = "version-bridge";

    constructor(private readonly operatorVersion: string) {}

    async run(ctx: RunContext): Promise<TaskResult> {
        const [panelConfig, opBin, rustCore, singboxCanon, singboxSrv] = await Promise.all([
            readPanelConfigVersion(ctx.cwd),
            Promise.resolve(operatorBinaryVersion(this.operatorVersion)),
            readRustCoreVersion(),
            readSingboxCanonical(ctx.cwd),
            readSingboxServerVersion(),
        ]);
        const report = classifyBridge([panelConfig, opBin, rustCore]);
        // The sing-box bridge tracks the v0.4.0+ invariant that the
        // running server-side sing-box matches the pin in
        // singbox-core/singbox.upstream.json. The two version-string
        // spaces are unrelated (ct-* in 0.x; sing-box in 1.x), so we
        // run them as separate classifications.
        const singboxReport = classifySingboxBridge(singboxCanon, singboxSrv);

        if (ctx.json) {
            process.stdout.write(JSON.stringify({ ct: report, singbox: singboxReport }) + "\n");
            return mergedResult(report, singboxReport);
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

        // Second table: sing-box pin ↔ running server-side binary.
        process.stdout.write(
            `\nSing-box bridge (v0.4.0+ — running binary must match the pin)\n` +
                `  layer            version           source\n` +
                `  ---------------  ----------------  --------------------\n`,
        );
        for (const l of singboxReport.layers) {
            const marker = l.version === singboxReport.canonical ? " " : "!";
            const v = l.version ?? "?";
            process.stdout.write(
                ` ${marker}${l.layer.padEnd(15)}  ${v.padEnd(16)}  ${l.source}` +
                    (l.error ? `   (${l.error})` : "") +
                    `\n`,
            );
        }
        if (singboxReport.agreed) {
            process.stdout.write(
                `\n✓ ct-singbox is running ${singboxReport.canonical ?? "?"} matching the pin\n`,
            );
        } else if (singboxReport.canonical === null) {
            process.stdout.write(`\n✗ could not read any sing-box layer\n`);
        } else {
            process.stdout.write(
                `\n✗ sing-box drift; canonical pin = ${singboxReport.canonical}\n` +
                    `  Mismatched layers:\n`,
            );
            for (const l of singboxReport.mismatches) {
                process.stdout.write(`    ${l.layer} reports ${l.version}\n`);
            }
            process.stdout.write(
                `\n  Likely fix:\n` +
                    `    ./ct update                          # rebuild ct-singbox at the current pin\n` +
                    `    # or, if the pin itself needs bumping:\n` +
                    `    $EDITOR singbox-core/singbox.upstream.json   # then ./ct update\n`,
            );
        }

        return mergedResult(report, singboxReport);
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

function mergedResult(ct: BridgeReport, singbox: BridgeReport): TaskResult {
    const ctR = reportToResult(ct, "ct");
    const singboxR = reportToResult(singbox, "singbox");
    if (ctR.ok && singboxR.ok) {
        return { ok: true, code: 0, summary: `${ctR.summary}; ${singboxR.summary}` };
    }
    // Worst-of: skew (code 1) is more actionable than unreadable
    // (code 2); merged exit prefers 1 over 2 because skew has a
    // remediation and unreadable usually means "stack isn't up".
    const code = ctR.code === 1 || singboxR.code === 1 ? 1 : Math.max(ctR.code, singboxR.code);
    const parts = [ctR, singboxR].filter((r) => !r.ok).map((r) => r.summary);
    return { ok: false, code, summary: parts.join("; "), skipBridge: true };
}
