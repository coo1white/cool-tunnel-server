// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/stale_deployment.ts — pure-TS port of
// scripts/fix.sh recipe 17.
//
// Detect: this checkout is a git work-tree, origin can be fetched,
// the latest tag on origin/main is newer than the version recorded
// in panel/config/cool-tunnel.php. Fix: git pull --ff-only origin
// main, then ./scripts/update.sh (the canonical update entry point).
//
// Companion to scripts/auto_update.sh (the unattended path). This
// recipe is the interactive one — an operator running `ct fix` gets a
// one-keystroke catch-up, with the option to skip if they want to
// stay pinned.

import type { Recipe } from "./types";
import { $, capture } from "../../util/sh";
import { probeVersions, upgradeAvailable, type VersionState } from "../../util/release";

async function detectStale(): Promise<boolean> {
    const v = await probeVersions();
    if (!v) return false;
    return upgradeAvailable(v);
}

function describeText(v: VersionState | null): string {
    const latest = v?.latest ?? "<unknown>";
    const current = v?.current ?? "<unknown>";
    return `A newer Cool Tunnel release is available.

  Currently deployed:  v${current}
  Latest on origin:    ${latest}

Releases ship bug fixes, security hardening, and new fix-agent
recipes that catch issues we've actually seen in the wild. Falling
behind is fine for short windows but accumulates risk over time.

Fix: pulls origin/main + runs the standard update flow
(\`./scripts/update.sh\`). That is:
  - git pull --ff-only (no rebase, no merge commits)
  - rebuilds the Rust core + Docker images (cached when nothing
    changed)
  - migrates the database (idempotent)
  - re-renders sing-box + haproxy configs
  - runs the post-swap component check
  - confirms ✓ Update complete.

If you want to STAY pinned at v${current} (e.g. you're between
deploys and don't want surprises), pick [s]kip. The recipe will
notice the next time you run ct fix.

If you want this to happen automatically without you running
ct fix, enable the unattended path: \`ct auto-update enable\`
(adds a /etc/cron.daily symlink; ships with v0.1.3+).`;
}

export const recipe: Recipe = {
    slug: "stale_deployment",
    async describe() {
        return describeText(await probeVersions());
    },
    detect: detectStale,
    async fix() {
        const pull = await capture($`git pull --ff-only origin main`);
        if (!pull.ok) {
            return {
                ok: false,
                detail: pull.stderr.split("\n")[0] || "git pull --ff-only failed",
            };
        }
        const update = await capture($`./scripts/update.sh`);
        if (!update.ok) {
            return {
                ok: false,
                detail: update.stderr.split("\n")[0] || `update.sh exited ${update.code}`,
            };
        }
        return { ok: true };
    },
    async verify() {
        return !(await detectStale());
    },
};
