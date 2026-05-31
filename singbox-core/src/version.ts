// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/src/version.ts — version + upstream pin accessors.

import upstreamRaw from "../singbox.upstream.json" with { type: "json" };

/** singbox-core release line (bumped in lockstep with cool-tunnel-server). */
export const SINGBOX_CORE_VERSION = "0.6.6";

/** Pinned sing-box upstream version this binary expects. */
export const SINGBOX_UPSTREAM_TAG: string = (upstreamRaw as { upstream_tag: string }).upstream_tag;

export type UpstreamAsset = {
  readonly url: string;
  readonly sha256: string;
  readonly size_bytes: number;
};

type UpstreamPin = {
  readonly upstream_tag: string;
  readonly upstream_published_at: string;
  readonly fetched_at: string;
  readonly assets: Record<string, UpstreamAsset>;
};

/** Full pin record loaded at compile time from singbox.upstream.json. */
export const SINGBOX_UPSTREAM: UpstreamPin = upstreamRaw as UpstreamPin;

/**
 * Asset key for the current Bun build target.
 *
 * Resolves to one of: linux-amd64 / linux-arm64 / darwin-amd64 / darwin-arm64.
 * Throws on unsupported host so the operator hits the failure
 * during install rather than at first spawn.
 */
export function currentAssetKey(): keyof typeof SINGBOX_UPSTREAM.assets {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "linux" && arch === "x64") return "linux-amd64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-amd64";
  throw new Error(
    `unsupported host platform/arch: ${platform}/${arch}; ` +
      `singbox-core supports linux-x64, linux-arm64, darwin-arm64, darwin-x64`,
  );
}
