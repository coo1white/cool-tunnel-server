// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/version-bridge.ts — read + compare the version
// each runtime layer reports for the deployment.
//
// v0.4.0+ runtimes:
//
//   - panel/config/cool-tunnel.php  → declared PHP runtime version
//   - ct-server-core (Rust)          → core binary, inside panel container
//   - operator/bin/ct-operator-<...> → the operator CLI itself
//   - singbox-core/singbox.upstream.json → canonical sing-box tag pin
//   - ct-singbox → running sing-box binary inside the proxy container
//
// (The `ct` wrapper script isn't a separate runtime — it just dispatches
// to the operator binary or to bash fallbacks.)
//
// What the v0.1.13-0.1.16 hot-fix chain proved: a wrapper that
// dispatches to a stale binary is the #1 deploy-skew failure mode.
// `ct version-bridge` surfaces that mismatch as a first-class signal:
//
//   1. Prints all readable layers side-by-side, exits non-zero on
//      disagreement (cron-friendly).
//   2. `ct doctor` includes a ballast check that fails on the same
//      condition with an actionable hint.
//   3. The `ct` wrapper itself self-bootstraps a matching binary
//      when a panel-config ↔ operator skew is detected.
//
// v0.4.0 collapsed three previous version-tracking surfaces (naive
// manifest pin, naive server runtime, naive client runtime) into
// ONE: the sing-box upstream tag pinned in
// singbox-core/singbox.upstream.json. Both server (ct-singbox) and
// client (cool-tunnel macOS app, after v3.0.0 cut) are rebuilt from
// the SAME tag, so the "do the two running binaries agree?" check
// becomes "do they both match the pin?".

import { $, capture } from "./sh";

export interface LayerVersion {
    readonly layer:
        | "panel-config"
        | "operator-binary"
        | "rust-core"
        | "singbox-pin"
        | "singbox-server";
    readonly version: string | null;
    readonly source: string;
    readonly error?: string;
}

export interface BridgeReport {
    readonly layers: readonly LayerVersion[];
    readonly agreed: boolean;
    readonly canonical: string | null;
    readonly mismatches: readonly LayerVersion[];
}

/**
 * sing-box's `version` subcommand prints
 *   sing-box version 1.13.12
 *   Environment: go1.22.x linux/amd64
 *   Tags: ...
 *
 * Our pin is `v1.13.12` (with leading `v`). Normalise both to the
 * bare semver so the comparator is straightforward.
 */
export function normaliseSingboxVersion(v: string): string {
    return v.replace(/^v/, "").trim();
}

// ---------- pure parsers ----------

/**
 * Extract the `'version' => 'X.Y.Z'` line from
 * panel/config/cool-tunnel.php. Returns null if absent or malformed.
 */
export function parsePanelConfigVersion(php: string): string | null {
    const m = php.match(/'version'\s*=>\s*'([^']+)'/);
    return m && m[1] ? m[1] : null;
}

/**
 * Extract `ct-server-core 0.x.y` (the version word) from
 * `ct-server-core --version` output.
 */
export function parseCoreVersionOutput(out: string): string | null {
    const m = out.trim().match(/^ct-server-core\s+(\S+)/);
    return m && m[1] ? m[1] : null;
}

/**
 * Parse `sing-box version` output. First line is
 *   sing-box version 1.13.12
 */
export function parseSingboxVersionOutput(out: string): string | null {
    const m = out.trim().match(/^sing-box\s+version\s+(\S+)/m);
    return m && m[1] ? m[1] : null;
}

// ---------- classifier ----------

/**
 * Decide if all readable layers report the same version.
 *
 * "Readable" = `version !== null`. A layer that errored is reported
 * but doesn't gate agreement (docker not on PATH = `warn` not
 * mismatch).
 */
export function classifyBridge(layers: readonly LayerVersion[]): BridgeReport {
    const readable = layers.filter((l) => l.version !== null);
    if (readable.length === 0) {
        return { layers, agreed: false, canonical: null, mismatches: [] };
    }
    const canonical =
        readable.find((l) => l.layer === "panel-config")?.version ??
        readable[0]!.version!;
    const mismatches = readable.filter((l) => l.version !== canonical);
    return { layers, agreed: mismatches.length === 0, canonical, mismatches };
}

// ---------- side-effecting readers ----------

export async function readPanelConfigVersion(cwd: string): Promise<LayerVersion> {
    const path = `${cwd}/panel/config/cool-tunnel.php`;
    const f = Bun.file(path);
    if (!(await f.exists())) {
        return { layer: "panel-config", version: null, source: path, error: "file not found" };
    }
    const version = parsePanelConfigVersion(await f.text());
    if (version === null) {
        return { layer: "panel-config", version: null, source: path, error: "version field not found" };
    }
    return { layer: "panel-config", version, source: path };
}

/**
 * The operator binary's compiled-in BUILD_VERSION. Passed in by the
 * caller (the caller has it via `declare const BUILD_VERSION`).
 */
export function operatorBinaryVersion(buildVersion: string): LayerVersion {
    return {
        layer: "operator-binary",
        version: buildVersion === "dev" ? null : buildVersion,
        source: "operator/bin/ct-operator-<os>-<arch>",
        ...(buildVersion === "dev" ? { error: "dev build (no BUILD_VERSION)" } : {}),
    };
}

/**
 * Read the canonical sing-box tag pinned in
 * singbox-core/singbox.upstream.json. Returns null if the file is
 * missing/malformed (treated as a "warn" by the caller — drift
 * detection still works between the two running layers).
 */
export async function readSingboxCanonical(cwd: string): Promise<LayerVersion> {
    const path = `${cwd}/singbox-core/singbox.upstream.json`;
    const f = Bun.file(path);
    if (!(await f.exists())) {
        return {
            layer: "singbox-pin",
            version: null,
            source: path,
            error: "file not found",
        };
    }
    try {
        const j = JSON.parse(await f.text());
        const tag = typeof j.upstream_tag === "string" ? j.upstream_tag : null;
        if (!tag) {
            return {
                layer: "singbox-pin",
                version: null,
                source: path,
                error: "upstream_tag missing",
            };
        }
        return {
            layer: "singbox-pin",
            version: normaliseSingboxVersion(tag),
            source: `${path} (upstream_tag, normalised)`,
        };
    } catch (e) {
        return {
            layer: "singbox-pin",
            version: null,
            source: path,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

/**
 * `docker compose exec -T singbox sing-box version` →
 * Surfaces the server-side running sing-box.
 */
export async function readSingboxServerVersion(): Promise<LayerVersion> {
    const r = await capture($`docker compose exec -T singbox sing-box version`);
    const source = "docker compose exec singbox sing-box version";
    if (!r.ok) {
        return {
            layer: "singbox-server",
            version: null,
            source,
            error: r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`,
        };
    }
    const version = parseSingboxVersionOutput(r.stdout);
    if (version === null) {
        return { layer: "singbox-server", version: null, source, error: "unexpected output shape" };
    }
    return { layer: "singbox-server", version, source };
}

/**
 * Compare sing-box running binary against the canonical pin. Unlike
 * classifyBridge (which picks panel-config as canonical), this one
 * uses the manifest tag as canonical — it's the single source of
 * truth for the running binary.
 *
 * v0.4.0 only has ONE running sing-box on the server side
 * (cool-tunnel-server); the v0.3.x naive-client-runtime layer is
 * gone (sing-box on the client lives in the cool-tunnel macOS app
 * and isn't reachable from the operator's docker context).
 */
export function classifySingboxBridge(
    canonical: LayerVersion,
    server: LayerVersion,
): BridgeReport {
    const layers = [canonical, server] as const;
    const readable = layers.filter((l) => l.version !== null);
    if (readable.length === 0) {
        return { layers, agreed: false, canonical: null, mismatches: [] };
    }
    const canon = canonical.version ?? readable[0]!.version!;
    const mismatches = readable.filter((l) => l.version !== canon);
    return { layers, agreed: mismatches.length === 0, canonical: canon, mismatches };
}

export async function readRustCoreVersion(): Promise<LayerVersion> {
    const r = await capture($`docker compose exec -T panel ct-server-core --version`);
    if (!r.ok) {
        return {
            layer: "rust-core",
            version: null,
            source: "docker compose exec panel ct-server-core --version",
            error: r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`,
        };
    }
    const version = parseCoreVersionOutput(r.stdout);
    if (version === null) {
        return {
            layer: "rust-core",
            version: null,
            source: "docker compose exec panel ct-server-core --version",
            error: "unexpected output shape",
        };
    }
    return { layer: "rust-core", version, source: "docker compose exec panel ct-server-core --version" };
}
