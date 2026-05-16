// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/src/subcommands/install.ts — fetch + verify + extract.
//
// Downloads the sing-box tarball pinned in singbox.upstream.json for
// the current host platform, SHA-256-verifies it against the pin,
// extracts the `sing-box` binary, and atomic-renames it to the
// target path. No fallbacks; if any step fails we abort and exit
// non-zero. Operator can re-run after fixing the environment.
//
// Pinned assets are platform-specific; see version.ts::currentAssetKey
// for the linux-amd64 / darwin-arm64 / darwin-amd64 resolution.

import { mkdtempSync, mkdirSync, renameSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { SINGBOX_UPSTREAM, SINGBOX_UPSTREAM_TAG, currentAssetKey } from "../version.ts";
import { sha256Hex } from "../util/sha256.ts";

interface ParsedArgs {
    readonly targetDir: string;
    readonly verify: boolean;
    readonly help: boolean;
}

const DEFAULT_TARGET_DIR = "/usr/local/bin";

function parseArgs(argv: readonly string[]): ParsedArgs {
    let targetDir = DEFAULT_TARGET_DIR;
    let verify = true;
    let help = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === "--target-dir") targetDir = argv[++i] ?? targetDir;
        else if (a === "--no-verify") verify = false;
        else if (a === "--help" || a === "-h") help = true;
        else throw new Error(`unknown flag: ${a}`);
    }
    return { targetDir, verify, help };
}

function usage(): string {
    return [
        "Usage: singbox-core install [--target-dir <path>] [--no-verify]",
        "",
        "  --target-dir   Install sing-box to <path>/sing-box (default: /usr/local/bin)",
        "  --no-verify    Skip the `sing-box --version` post-install sanity check.",
    ].join("\n");
}

export async function runInstall(argv: readonly string[]): Promise<number> {
    const args = parseArgs(argv);
    if (args.help) {
        process.stdout.write(usage() + "\n");
        return 0;
    }

    const assetKey = currentAssetKey();
    const asset = SINGBOX_UPSTREAM.assets[assetKey];
    if (!asset) {
        throw new Error(
            `singbox.upstream.json missing pin for "${assetKey}" — refresh pin file`,
        );
    }

    log("info", "downloading", { url: asset.url, sha256: asset.sha256, size: asset.size_bytes });

    const tmpdirPath = mkdtempSync(join(tmpdir(), "singbox-install-"));
    const tarballPath = join(tmpdirPath, "singbox.tar.gz");

    const resp = await fetch(asset.url, { redirect: "follow" });
    if (!resp.ok) {
        throw new Error(`fetch failed: ${resp.status} ${resp.statusText} from ${asset.url}`);
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength !== asset.size_bytes) {
        throw new Error(
            `size mismatch: pin expects ${asset.size_bytes} bytes, got ${bytes.byteLength}`,
        );
    }
    const actualSha = await sha256Hex(bytes);
    if (actualSha !== asset.sha256) {
        throw new Error(
            `sha256 mismatch: pin ${asset.sha256}, downloaded ${actualSha}; ABORT, do NOT install`,
        );
    }
    writeFileSync(tarballPath, bytes, { mode: 0o600 });
    log("info", "sha_verified", { sha256: actualSha });

    // Extract the binary. The release tarball is gzipped tar with a
    // single top-level directory `sing-box-<version>-<os>-<arch>/`
    // containing `sing-box`, `LICENSE`, and a config sample. We
    // shell to `tar` rather than re-implementing tar in TypeScript —
    // both runtime hosts (linux-alpine container + macOS) have it.
    log("info", "extracting");
    const extractResult = spawnSync("tar", ["-xzf", tarballPath, "-C", tmpdirPath], {
        stdio: "inherit",
    });
    if (extractResult.status !== 0) {
        throw new Error(`tar -xzf failed with exit ${extractResult.status}`);
    }

    // The extracted folder name is predictable from the tag and asset
    // key (e.g. "sing-box-1.13.12-linux-amd64").
    const versionStr = SINGBOX_UPSTREAM_TAG.replace(/^v/, "");
    const extractedDir = join(tmpdirPath, `sing-box-${versionStr}-${assetKey}`);
    const extractedBin = join(extractedDir, "sing-box");
    if (!safeStat(extractedBin)?.isFile()) {
        throw new Error(`expected ${extractedBin} after extract; tarball layout changed?`);
    }

    mkdirSync(args.targetDir, { recursive: true });
    const finalPath = join(args.targetDir, "sing-box");
    renameSync(extractedBin, finalPath);
    chmodSync(finalPath, 0o755);
    log("info", "installed", { path: finalPath });

    if (args.verify) {
        const out = spawnSync(finalPath, ["version"], { encoding: "utf8" });
        if (out.status !== 0) {
            throw new Error(
                `post-install verify failed: \`sing-box version\` exited ${out.status}`,
            );
        }
        log("info", "post_install_version", {
            stdout: out.stdout.split("\n")[0]?.trim() ?? "",
        });
    }
    return 0;
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
    try {
        return statSync(path);
    } catch {
        return null;
    }
}

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) {
    process.stderr.write(
        JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + "\n",
    );
}

// Silence unused-import warning when the linter complains; dirname is
// reserved for future relative-path features.
const _dirname = dirname;
void _dirname;
