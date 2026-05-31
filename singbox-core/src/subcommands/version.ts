// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/src/subcommands/version.ts — print version info.

import { SINGBOX_CORE_VERSION, SINGBOX_UPSTREAM_TAG } from "../version.ts";

export function runVersion(argv: readonly string[]): number {
  if (argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({
        singbox_core: SINGBOX_CORE_VERSION,
        singbox_upstream: SINGBOX_UPSTREAM_TAG,
      })}\n`,
    );
    return 0;
  }
  process.stdout.write(`singbox-core ${SINGBOX_CORE_VERSION}\n`);
  process.stdout.write(`sing-box (pinned) ${SINGBOX_UPSTREAM_TAG}\n`);
  return 0;
}
