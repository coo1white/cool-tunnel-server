// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/version-bridge.test.ts — pure-logic tests for
// the cross-layer version-skew detector.

import { test, expect } from "bun:test";
import {
    classifyBridge,
    classifySingboxBridge,
    normaliseSingboxVersion,
    operatorBinaryVersion,
    parseCoreVersionOutput,
    parseSingboxVersionOutput,
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

// ---------- normaliseSingboxVersion (v0.4.0+) ----------

test("normaliseSingboxVersion strips leading 'v'", () => {
    expect(normaliseSingboxVersion("v1.13.12")).toBe("1.13.12");
});

test("normaliseSingboxVersion is idempotent on already-normalised input", () => {
    expect(normaliseSingboxVersion("1.13.12")).toBe("1.13.12");
});

test("normaliseSingboxVersion preserves trailing pre-release / build suffixes", () => {
    // Unlike v0.3.x naive (which used a `-N` rebuild suffix we'd
    // strip), SagerNet/sing-box uses semver tags. `1.13.12-rc1`
    // is a different release from `1.13.12` and must compare
    // distinctly.
    expect(normaliseSingboxVersion("v1.13.12-rc1")).toBe("1.13.12-rc1");
});

// ---------- parseSingboxVersionOutput ----------

test("parseSingboxVersionOutput extracts the version from `sing-box version X.Y.Z`", () => {
    expect(parseSingboxVersionOutput("sing-box version 1.13.12\n")).toBe("1.13.12");
});

test("parseSingboxVersionOutput is tolerant of multi-line output (env + tags)", () => {
    const out =
        "sing-box version 1.13.12\nEnvironment: go1.22.0 linux/amd64\nTags: with_quic,with_wireguard\n";
    expect(parseSingboxVersionOutput(out)).toBe("1.13.12");
});

test("parseSingboxVersionOutput rejects unrelated output", () => {
    expect(parseSingboxVersionOutput("bash: sing-box: command not found")).toBeNull();
});

// ---------- classifySingboxBridge ----------

test("classifySingboxBridge: pin agrees with running server → agreed", () => {
    const r = classifySingboxBridge(
        layer("singbox-pin", "1.13.12"),
        layer("singbox-server", "1.13.12"),
    );
    expect(r.agreed).toBe(true);
    expect(r.canonical).toBe("1.13.12");
});

test("classifySingboxBridge: server drifts from pin → mismatch flagged", () => {
    const r = classifySingboxBridge(
        layer("singbox-pin", "1.13.12"),
        layer("singbox-server", "1.13.11"),
    );
    expect(r.agreed).toBe(false);
    expect(r.canonical).toBe("1.13.12");
    expect(r.mismatches.map((l) => l.layer)).toEqual(["singbox-server"]);
});

test("classifySingboxBridge: pin missing, server reachable → falls back to server", () => {
    // Pin absent doesn't break the audit; we fall back to whatever
    // the running binary reports as the canonical.
    const r = classifySingboxBridge(
        layer("singbox-pin", null),
        layer("singbox-server", "1.13.12"),
    );
    expect(r.agreed).toBe(true);
    expect(r.canonical).toBe("1.13.12");
});

test("classifySingboxBridge: nothing readable → no canonical", () => {
    const r = classifySingboxBridge(
        layer("singbox-pin", null),
        layer("singbox-server", null),
    );
    expect(r.agreed).toBe(false);
    expect(r.canonical).toBeNull();
});
