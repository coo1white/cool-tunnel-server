// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/version-bridge.test.ts — pure-logic tests for
// the cross-layer version-skew detector.

import { test, expect } from "bun:test";
import {
    classifyBridge,
    classifyNaiveBridge,
    normaliseNaiveVersion,
    operatorBinaryVersion,
    parseCoreVersionOutput,
    parseNaiveVersionOutput,
    parsePanelConfigVersion,
    type LayerVersion,
} from "../src/util/version-bridge";

// ---------- parsePanelConfigVersion ----------

test("parsePanelConfigVersion extracts 'version' => 'X.Y.Z'", () => {
    const php = `<?php
return [
    'domain' => env('DOMAIN'),
    'version' => '0.1.14',
];`;
    expect(parsePanelConfigVersion(php)).toBe("0.1.14");
});

test("parsePanelConfigVersion handles multi-digit major", () => {
    const php = `'version' => '10.20.30'`;
    expect(parsePanelConfigVersion(php)).toBe("10.20.30");
});

test("parsePanelConfigVersion returns null when field absent", () => {
    expect(parsePanelConfigVersion(`<?php return ['domain' => 'x'];`)).toBeNull();
});

test("parsePanelConfigVersion is anchored to key+arrow (avoids stray matches)", () => {
    // A comment containing the word "version" but not as a config key
    // must not trip the matcher.
    const php = `<?php
// The version of this config schema is internal; do not edit.
return [
    'domain' => 'x',
];`;
    expect(parsePanelConfigVersion(php)).toBeNull();
});

// ---------- parseCoreVersionOutput ----------

test("parseCoreVersionOutput extracts 'ct-server-core X.Y.Z'", () => {
    expect(parseCoreVersionOutput("ct-server-core 0.1.14\n")).toBe("0.1.14");
});

test("parseCoreVersionOutput tolerates trailing build metadata", () => {
    expect(parseCoreVersionOutput("ct-server-core 0.1.14 (release)")).toBe("0.1.14");
});

test("parseCoreVersionOutput returns null on unexpected shape", () => {
    expect(parseCoreVersionOutput("???\n")).toBeNull();
    expect(parseCoreVersionOutput("")).toBeNull();
});

// ---------- operatorBinaryVersion ----------

test("operatorBinaryVersion('dev') reports null + error", () => {
    const r = operatorBinaryVersion("dev");
    expect(r.version).toBeNull();
    expect(r.error).toContain("dev build");
});

test("operatorBinaryVersion('0.1.14') reports normally", () => {
    const r = operatorBinaryVersion("0.1.14");
    expect(r.version).toBe("0.1.14");
    expect(r.error).toBeUndefined();
});

// ---------- classifyBridge ----------

function layer(layerName: LayerVersion["layer"], version: string | null): LayerVersion {
    return { layer: layerName, version, source: `test://${layerName}` };
}

test("classifyBridge: every readable layer agrees → agreed=true", () => {
    const r = classifyBridge([
        layer("panel-config", "0.1.14"),
        layer("operator-binary", "0.1.14"),
        layer("rust-core", "0.1.14"),
    ]);
    expect(r.agreed).toBe(true);
    expect(r.canonical).toBe("0.1.14");
    expect(r.mismatches).toEqual([]);
});

test("classifyBridge: operator-binary stale → mismatch on that layer", () => {
    const r = classifyBridge([
        layer("panel-config", "0.1.14"),
        layer("operator-binary", "0.1.12"),
        layer("rust-core", "0.1.14"),
    ]);
    expect(r.agreed).toBe(false);
    expect(r.canonical).toBe("0.1.14");
    expect(r.mismatches.length).toBe(1);
    expect(r.mismatches[0]!.layer).toBe("operator-binary");
});

test("classifyBridge: canonical = panel-config when present", () => {
    // Even when two layers agree on a value different from panel-config,
    // panel-config wins as the source of truth.
    const r = classifyBridge([
        layer("panel-config", "0.1.14"),
        layer("operator-binary", "0.1.13"),
        layer("rust-core", "0.1.13"),
    ]);
    expect(r.canonical).toBe("0.1.14");
    expect(r.mismatches.length).toBe(2);
});

test("classifyBridge: panel-config unreadable → canonical = first readable", () => {
    const r = classifyBridge([
        layer("panel-config", null),
        layer("operator-binary", "0.1.14"),
        layer("rust-core", "0.1.14"),
    ]);
    expect(r.agreed).toBe(true);
    expect(r.canonical).toBe("0.1.14");
});

test("classifyBridge: no layer readable → canonical=null, agreed=false", () => {
    const r = classifyBridge([
        layer("panel-config", null),
        layer("operator-binary", null),
        layer("rust-core", null),
    ]);
    expect(r.canonical).toBeNull();
    expect(r.agreed).toBe(false);
});

// ---------- normaliseNaiveVersion ----------

test("normaliseNaiveVersion strips leading 'v' and trailing rebuild suffix", () => {
    expect(normaliseNaiveVersion("v148.0.7778.96-5")).toBe("148.0.7778.96");
});

test("normaliseNaiveVersion is idempotent on already-normalised input", () => {
    expect(normaliseNaiveVersion("148.0.7778.96")).toBe("148.0.7778.96");
});

test("normaliseNaiveVersion does NOT strip trailing version segments (4-part)", () => {
    // The 4th `.96` is part of the version, not a rebuild suffix.
    // Only `-N` after the last digit is a rebuild suffix.
    expect(normaliseNaiveVersion("v148.0.7778.96")).toBe("148.0.7778.96");
});

// ---------- parseNaiveVersionOutput ----------

test("parseNaiveVersionOutput extracts the version from `naive X.Y.Z.W`", () => {
    expect(parseNaiveVersionOutput("naive 148.0.7778.96\n")).toBe("148.0.7778.96");
});

test("parseNaiveVersionOutput is tolerant of trailing build metadata", () => {
    expect(parseNaiveVersionOutput("naive 148.0.7778.96 (custom build)")).toBe("148.0.7778.96");
});

test("parseNaiveVersionOutput rejects unrelated output", () => {
    expect(parseNaiveVersionOutput("bash: naive: command not found")).toBeNull();
});

// ---------- classifyNaiveBridge ----------

test("classifyNaiveBridge: manifest agrees with server + client → agreed", () => {
    const r = classifyNaiveBridge(
        layer("naive-server", "148.0.7778.96"),
        layer("naive-server", "148.0.7778.96"),
        layer("naive-client", "148.0.7778.96"),
    );
    expect(r.agreed).toBe(true);
    expect(r.canonical).toBe("148.0.7778.96");
});

test("classifyNaiveBridge: client drifts → mismatch flagged", () => {
    const r = classifyNaiveBridge(
        layer("naive-server", "148.0.7778.96"),
        layer("naive-server", "148.0.7778.96"),
        layer("naive-client", "147.0.0.0"),
    );
    expect(r.agreed).toBe(false);
    expect(r.canonical).toBe("148.0.7778.96");
    expect(r.mismatches.map((l) => l.layer)).toEqual(["naive-client"]);
});

test("classifyNaiveBridge: manifest missing, both running agree → still agreed", () => {
    // Manifest absent doesn't break the fundamental server==client
    // invariant; we fall back to the running binaries.
    const r = classifyNaiveBridge(
        layer("naive-server", null),
        layer("naive-server", "148.0.7778.96"),
        layer("naive-client", "148.0.7778.96"),
    );
    expect(r.agreed).toBe(true);
    expect(r.canonical).toBe("148.0.7778.96");
});

test("classifyNaiveBridge: manifest missing AND running binaries disagree → mismatch", () => {
    const r = classifyNaiveBridge(
        layer("naive-server", null),
        layer("naive-server", "148.0.7778.96"),
        layer("naive-client", "147.0.0.0"),
    );
    expect(r.agreed).toBe(false);
    // Canonical falls back to the first readable layer.
    expect(r.canonical).toBe("148.0.7778.96");
    expect(r.mismatches.map((l) => l.layer)).toEqual(["naive-client"]);
});

test("classifyNaiveBridge: nothing readable → no canonical", () => {
    const r = classifyNaiveBridge(
        layer("naive-server", null),
        layer("naive-server", null),
        layer("naive-client", null),
    );
    expect(r.agreed).toBe(false);
    expect(r.canonical).toBeNull();
});
