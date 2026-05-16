// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/version-bridge.ts — read + compare the version
// each runtime layer reports for the deployment.
//
// Three runtimes ship from the same repo and must agree on what
// version they're running:
//
//   - panel/config/cool-tunnel.php  → declared PHP runtime version
//   - ct-server-core (Rust)          → core binary, inside panel container
//   - operator/bin/ct-operator-<...> → the operator CLI itself
//
// (The `ct` wrapper script isn't a separate runtime — it just dispatches
// to the operator binary or to bash fallbacks, so it has no independent
// version string to surface.)
//
// What the v0.1.13-0.1.16 hot-fix chain proved: a wrapper that dispatches
// to a stale binary is the #1 deploy-skew failure mode. The operator on
// disk being older than panel/config/cool-tunnel.php means the wrapper
// invokes subcommands that the binary doesn't have ("unknown command:
// update"), with no auto-recovery in v0.1.12. This module surfaces that
// mismatch as a first-class signal so:
//
//   1. `ct version-bridge` prints all three side-by-side
//      and exits non-zero when they disagree (cron-friendly).
//   2. `ct doctor` includes a ballast check that fails on the same
//      condition with an actionable hint.
//   3. The `ct` wrapper itself can self-bootstrap by fetching the
//      matching binary before dispatching when a skew is detected.

import { $, capture } from "./sh";

export interface LayerVersion {
    readonly layer:
        | "panel-config"
        | "operator-binary"
        | "rust-core"
        | "naive-server"
        | "naive-client";
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
 * `naive --version` prints `naive <X.Y.Z.W>` (no `v` prefix, no
 * release-suffix). The manifest pin is `vX.Y.Z.W-N` (asset tag),
 * so normalisation strips the leading `v` and the trailing `-N`
 * before comparison. Both sides go through the same normaliser so
 * a future format change moves them together.
 */
export function normaliseNaiveVersion(v: string): string {
    return v.replace(/^v/, "").replace(/-\d+$/, "").trim();
}

// ---------- pure parsers ----------

/**
 * Extract the `'version' => 'X.Y.Z'` line from
 * panel/config/cool-tunnel.php. Returns null if absent or malformed.
 *
 * Match is anchored to the start of a key+arrow so a stray
 * comment containing the word "version" doesn't trip it.
 */
export function parsePanelConfigVersion(php: string): string | null {
    const m = php.match(/'version'\s*=>\s*'([^']+)'/);
    return m && m[1] ? m[1] : null;
}

/**
 * Extract `ct-server-core 0.1.x` (the version word) from
 * `ct-server-core --version` output. Tolerates trailing build
 * metadata.
 */
export function parseCoreVersionOutput(out: string): string | null {
    const m = out.trim().match(/^ct-server-core\s+(\S+)/);
    return m && m[1] ? m[1] : null;
}

// ---------- classifier ----------

/**
 * Decide if all readable layers report the same version.
 *
 * "Readable" = `version !== null`. A layer that errored is reported
 * but doesn't gate agreement (e.g. docker not on PATH on a dev
 * laptop is a `warn`, not a mismatch).
 */
export function classifyBridge(layers: readonly LayerVersion[]): BridgeReport {
    const readable = layers.filter((l) => l.version !== null);
    if (readable.length === 0) {
        return { layers, agreed: false, canonical: null, mismatches: [] };
    }
    // Canonical = panel-config when present; otherwise the first readable.
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
 * `docker compose exec -T panel ct-server-core --version` →
 * parse the "ct-server-core X.Y.Z" line.
 */
/**
 * Parse `naive --version` output. Upstream prints `naive 148.0.7778.96`
 * (single line, no `v` prefix, no rebuild suffix). Tolerant of leading
 * whitespace and trailing build metadata.
 */
export function parseNaiveVersionOutput(out: string): string | null {
    const m = out.trim().match(/^naive\s+(\S+)/);
    return m && m[1] ? m[1] : null;
}

/**
 * Read the manifest's canonical naive tag. Returns null if the file
 * is missing/malformed (treated as a "warn" by the caller — drift
 * detection still works between the two running layers).
 */
export async function readNaiveCanonical(cwd: string): Promise<LayerVersion> {
    const path = `${cwd}/manifests/naive.upstream.json`;
    const f = Bun.file(path);
    if (!(await f.exists())) {
        return {
            layer: "naive-server",
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
                layer: "naive-server",
                version: null,
                source: path,
                error: "upstream_tag missing",
            };
        }
        return {
            layer: "naive-server",
            version: normaliseNaiveVersion(tag),
            source: `${path} (upstream_tag, normalised)`,
        };
    } catch (e) {
        return {
            layer: "naive-server",
            version: null,
            source: path,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

/**
 * `docker compose exec -T naive naive --version` →
 * `naive X.Y.Z.W`. Surfaces the server-side running binary.
 */
export async function readNaiveServerVersion(): Promise<LayerVersion> {
    const r = await capture($`docker compose exec -T naive naive --version`);
    const source = "docker compose exec naive naive --version";
    if (!r.ok) {
        return {
            layer: "naive-server",
            version: null,
            source,
            error: r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`,
        };
    }
    const version = parseNaiveVersionOutput(r.stdout);
    if (version === null) {
        return { layer: "naive-server", version: null, source, error: "unexpected output shape" };
    }
    return { layer: "naive-server", version, source };
}

/**
 * `docker compose exec -T panel /usr/local/bin/naive --version` →
 * `naive X.Y.Z.W`. Surfaces the client-side running binary (the one
 * the anti-tracking probe shells out to).
 */
export async function readNaiveClientVersion(): Promise<LayerVersion> {
    const r = await capture($`docker compose exec -T panel /usr/local/bin/naive --version`);
    const source = "docker compose exec panel /usr/local/bin/naive --version";
    if (!r.ok) {
        return {
            layer: "naive-client",
            version: null,
            source,
            error: r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`,
        };
    }
    const version = parseNaiveVersionOutput(r.stdout);
    if (version === null) {
        return { layer: "naive-client", version: null, source, error: "unexpected output shape" };
    }
    return { layer: "naive-client", version, source };
}

/**
 * Compare naive layers against the manifest's canonical tag. Unlike
 * classifyBridge (which picks panel-config as canonical), this one
 * uses the manifest tag as canonical — it's the single source of
 * truth for both the running binaries.
 *
 * A null canonical (manifest missing/unreadable) falls back to
 * "do the two running binaries agree with each other?" — the
 * fundamental invariant still holds when the manifest is absent.
 */
export function classifyNaiveBridge(
    canonical: LayerVersion,
    server: LayerVersion,
    client: LayerVersion,
): BridgeReport {
    const layers = [canonical, server, client] as const;
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
