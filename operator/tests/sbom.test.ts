// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/sbom.test.ts — pure logic in operator/sbom.ts
// (cdxgen picker, manifest builder, Cargo.toml version extractor).

import { test, expect } from "bun:test";
import { pickCdxgen, buildCombinedManifest, extractCargoVersion } from "../sbom";

test("pickCdxgen prefers cdxgen on PATH", () => {
    expect(pickCdxgen({ hasCdxgen: true, hasBunx: true, hasNpx: true })).toEqual(["cdxgen"]);
});

test("pickCdxgen falls back to bunx when cdxgen missing", () => {
    expect(pickCdxgen({ hasCdxgen: false, hasBunx: true, hasNpx: true })).toEqual([
        "bunx",
        "--bun",
        "@cyclonedx/cdxgen",
    ]);
});

test("pickCdxgen falls back to npx when cdxgen and bunx missing", () => {
    expect(pickCdxgen({ hasCdxgen: false, hasBunx: false, hasNpx: true })).toEqual([
        "npx",
        "--yes",
        "@cyclonedx/cdxgen",
    ]);
});

test("pickCdxgen returns null when nothing is available", () => {
    expect(pickCdxgen({ hasCdxgen: false, hasBunx: false, hasNpx: false })).toBeNull();
});

test("extractCargoVersion reads the first version line", () => {
    const toml = `[workspace]
members = ["ct-server-core"]

[workspace.package]
version = "0.1.15"
edition = "2021"
`;
    expect(extractCargoVersion(toml)).toBe("0.1.15");
});

test("extractCargoVersion returns null for a TOML without a version", () => {
    const toml = `[workspace]
members = ["ct-server-core"]
`;
    expect(extractCargoVersion(toml)).toBeNull();
});

test("buildCombinedManifest produces a valid CycloneDX 1.5 envelope", () => {
    const m = buildCombinedManifest({ timestamp: "2026-05-15T16-40-00Z", version: "0.1.15" });
    expect(m.bomFormat).toBe("CycloneDX");
    expect(m.specVersion).toBe("1.5");
    expect(m.serialNumber).toBe("urn:uuid:2026-05-15T16-40-00Z");
    expect(m.version).toBe(1);
    expect(m.metadata.component.version).toBe("0.1.15");
    expect(m.metadata.component.name).toBe("cool-tunnel-server");
});

test("buildCombinedManifest x-references list covers every per-tool SBOM", () => {
    const m = buildCombinedManifest({ timestamp: "2026-05-15T16-40-00Z", version: "0.1.15" });
    const refs = m["x-references"];
    expect(refs).toContain("cargo.cdx.json");
    expect(refs).toContain("composer.cdx.json");
    expect(refs).toContain("cool-tunnel-server-core.cdx.json");
    expect(refs).toContain("cool-tunnel-server-caddy.cdx.json");
    expect(refs).toContain("cool-tunnel-server-singbox.cdx.json");
    expect(refs).toContain("cool-tunnel-server-panel.cdx.json");
    expect(refs).toHaveLength(6);
});
