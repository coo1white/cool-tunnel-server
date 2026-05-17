#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/sbom.ts — generate CycloneDX SBOMs for cargo + composer + docker.
//
// Produce CycloneDX SBOMs for everything that goes into a release
// artefact. Output lands in `sbom/`. Each release uploads these to
// GitHub.
//
// Tools used:
//   - cargo-cyclonedx for the Rust workspace
//   - cyclonedx/cdxgen for the Composer panel and Docker images
//
// cargo-cyclonedx is auto-installed via `cargo install --locked`
// when missing. cdxgen is invoked via the first of: cdxgen on PATH,
// `bunx --bun @cyclonedx/cdxgen`, `npx --yes @cyclonedx/cdxgen`.
//
// Idempotent — re-running just regenerates the files.

import { $ } from "bun";
import { die, makeTerm } from "./src/util/term";
import { ensureRepoRoot } from "./src/util/repo-root";

const { step, ok, warn } = makeTerm();

const DOCKER_IMAGES = [
    "cool-tunnel-server-caddy",
    "cool-tunnel-server-singbox",
    "cool-tunnel-server-panel",
    "cool-tunnel-server-core",
] as const;

// Pick the first usable cdxgen invocation. Returns null when none
// is available — the script then warn-skips the PHP and docker
// SBOM steps (matches the bash original). Exported for tests.
export function pickCdxgen(opts: {
    hasCdxgen: boolean;
    hasBunx: boolean;
    hasNpx: boolean;
}): readonly string[] | null {
    if (opts.hasCdxgen) return ["cdxgen"];
    if (opts.hasBunx) return ["bunx", "--bun", "@cyclonedx/cdxgen"];
    if (opts.hasNpx) return ["npx", "--yes", "@cyclonedx/cdxgen"];
    return null;
}

export interface CombinedManifest {
    readonly bomFormat: "CycloneDX";
    readonly specVersion: "1.5";
    readonly serialNumber: string;
    readonly version: 1;
    readonly metadata: {
        readonly timestamp: string;
        readonly component: {
            readonly type: "application";
            readonly "bom-ref": "cool-tunnel-server";
            readonly name: "cool-tunnel-server";
            readonly version: string;
        };
        readonly tools: ReadonlyArray<{ vendor: string; name: string; version: string }>;
    };
    readonly components: ReadonlyArray<unknown>;
    readonly "x-references": ReadonlyArray<string>;
}

// Compose the release-level SBOM index manifest. CycloneDX 1.5 with
// an x-references list pointing at the per-tool SBOMs. Exported for
// tests. Pure — no I/O, no Date.now() side-effects.
export function buildCombinedManifest(opts: {
    timestamp: string; // e.g. "2026-05-15T16-40-00Z"
    version: string;   // e.g. "0.1.15"
}): CombinedManifest {
    return {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        serialNumber: `urn:uuid:${opts.timestamp}`,
        version: 1,
        metadata: {
            timestamp: opts.timestamp,
            component: {
                type: "application",
                "bom-ref": "cool-tunnel-server",
                name: "cool-tunnel-server",
                version: opts.version,
            },
            tools: [{ vendor: "cool-tunnel-server", name: "operator/sbom.ts", version: "0.0.6" }],
        },
        components: [],
        "x-references": [
            "cargo.cdx.json",
            "composer.cdx.json",
            "cool-tunnel-server-core.cdx.json",
            "cool-tunnel-server-caddy.cdx.json",
            "cool-tunnel-server-singbox.cdx.json",
            "cool-tunnel-server-panel.cdx.json",
        ],
    };
}

// Read core/Cargo.toml and extract the workspace package version.
// Exported for tests.
export function extractCargoVersion(cargoToml: string): string | null {
    // Match the first `version = "X.Y.Z"` line (cargo-cyclonedx
    // expects a workspace-level version).
    const m = cargoToml.match(/^\s*version\s*=\s*"([^"]+)"/m);
    return m ? m[1]! : null;
}

function which(bin: string): boolean {
    return Bun.which(bin) !== null;
}

async function main(): Promise<number> {
    ensureRepoRoot(import.meta.url);

    // ---------- Cargo workspace ----------
    step("Generating Rust SBOM (cargo-cyclonedx)");
    if (!which("cargo-cyclonedx")) {
        warn("cargo-cyclonedx not on PATH; installing into ~/.cargo/bin");
        const inst = await $`cargo install --locked cargo-cyclonedx`.nothrow();
        if (inst.exitCode !== 0) {
            die("cargo install cargo-cyclonedx failed",
                "install rustup + cargo first, then re-run `make sbom`");
        }
    }
    {
        const r = await $`cargo cyclonedx --format json --override-filename ../sbom/cargo`
            .cwd("core")
            .nothrow();
        if (r.exitCode !== 0) {
            die("cargo cyclonedx failed in core/", "check `core/Cargo.lock` is in sync");
        }
    }
    ok("wrote sbom/cargo.cdx.json");

    // ---------- Composer panel ----------
    step("Generating PHP SBOM (cdxgen)");
    const cdxgen = pickCdxgen({
        hasCdxgen: which("cdxgen"),
        hasBunx: which("bunx"),
        hasNpx: which("npx"),
    });
    if (!cdxgen) {
        warn("no cdxgen / bunx / npx on PATH; skipping PHP SBOM");
    } else {
        const r = await $`${cdxgen} -t php -o ../sbom/composer.cdx.json --spec-version 1.5 --no-recurse`
            .cwd("panel")
            .nothrow();
        if (r.exitCode !== 0) {
            warn("cdxgen failed on panel/ (PHP SBOM skipped)");
        } else {
            ok("wrote sbom/composer.cdx.json");
        }
    }

    // ---------- Docker images ----------
    if (which("docker") && cdxgen) {
        step("Generating Docker SBOMs (cdxgen)");
        for (const image of DOCKER_IMAGES) {
            const inspect = await $`docker image inspect ${image}:latest`.nothrow().quiet();
            if (inspect.exitCode !== 0) {
                warn(`skipping ${image} (image not built locally)`);
                continue;
            }
            const r = await $`${cdxgen} -t docker -o sbom/${image}.cdx.json --spec-version 1.5 ${image}:latest`
                .nothrow()
                .quiet();
            if (r.exitCode !== 0) {
                warn(`cdxgen failed on ${image}`);
            } else {
                ok(`wrote sbom/${image}.cdx.json`);
            }
        }
    } else if (!which("docker")) {
        warn("docker not on PATH; skipping image SBOMs");
    }

    // ---------- Combined manifest ----------
    step("Composing release-level SBOM");
    const timestamp = new Date()
        .toISOString()
        .replace(/\.\d+Z$/, "Z")
        .replace(/:/g, "-");

    const cargoToml = await Bun.file("core/Cargo.toml").text();
    const version = extractCargoVersion(cargoToml);
    if (!version) {
        die("could not extract version from core/Cargo.toml",
            "check the workspace [package] block defines `version = \"X.Y.Z\"`");
    }
    const manifest = buildCombinedManifest({ timestamp, version });
    const out = `sbom/cool-tunnel-server-v${version}-sbom.cdx.json`;
    await Bun.write(out, JSON.stringify(manifest, null, 2) + "\n");
    ok(`wrote ${out}`);

    ok("SBOM generation complete. Files under sbom/:");
    const ls = await $`ls -lh sbom/`.nothrow().quiet();
    process.stdout.write(ls.stdout.toString().split("\n").slice(0, 20).join("\n") + "\n");
    return 0;
}

if (import.meta.main) {
    const code = await main();
    process.exit(code);
}
