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
import { $, capture, which } from "../../util/sh";

const VERSION_FILE = "panel/config/cool-tunnel.php";

interface VersionState {
    latest: string;
    current: string;
}

async function probeVersions(): Promise<VersionState | null> {
    if (!(await which("git"))) return null;
    const inWt = await capture($`git rev-parse --is-inside-work-tree`);
    if (!inWt.ok) return null;

    // Fetch tags + main quietly. Treat network blips as "no upgrade
    // available" — the recipe should not flap on a transient outage.
    const fetched = await capture($`git fetch --quiet --tags origin`);
    if (!fetched.ok) return null;

    const describe = await capture($`git describe --tags --abbrev=0 origin/main`);
    const latest = describe.ok ? describe.stdout.trim() : "";
    if (!latest) return null;

    const f = Bun.file(VERSION_FILE);
    if (!(await f.exists())) return null;
    const phpText = await f.text();
    // Match the canonical PHP config line:  'version' => '0.1.14',
    const m = phpText.match(/^\s*'version'\s*=>\s*'([0-9.]+)'/m);
    const current = m ? m[1]! : "";
    if (!current) return null;

    return { latest, current };
}

async function detectStale(): Promise<boolean> {
    const v = await probeVersions();
    if (!v) return false;
    // Latest is like 'v0.1.13'; current is like '0.1.13'. Strip 'v'.
    return v.latest.replace(/^v/, "") !== v.current;
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
