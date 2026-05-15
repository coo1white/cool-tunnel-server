// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/release.ts — version-probing helpers shared
// between the stale_deployment fix recipe and the auto-update task.
//
// "Current" version = panel/config/cool-tunnel.php's 'version' field
// (the single source of truth for `ct version`).
// "Latest" version  = git describe --tags --abbrev=0 origin/main
// after a `git fetch --tags origin`.

import { $, capture, which } from "./sh";

export const VERSION_FILE = "panel/config/cool-tunnel.php";

export interface VersionState {
    readonly latest: string;   // e.g. "v0.1.15"
    readonly current: string;  // e.g. "0.1.15" (no leading "v")
}

// Match the canonical PHP config line:  'version' => '0.1.14',
const VERSION_LINE_RE = /^\s*'version'\s*=>\s*'([0-9.]+)'/m;

export function parseCurrentVersion(phpText: string): string | null {
    const m = phpText.match(VERSION_LINE_RE);
    return m ? m[1]! : null;
}

// Read panel/config/cool-tunnel.php from the cwd and extract the
// version line. Returns null on missing file or unparseable line.
export async function readCurrentVersion(): Promise<string | null> {
    const f = Bun.file(VERSION_FILE);
    if (!(await f.exists())) return null;
    return parseCurrentVersion(await f.text());
}

// Full probe: git fetch + describe + read panel config. Returns null
// on any failure (no git, not a worktree, network blip, missing file,
// missing tag). Callers treat null as "no upgrade available" so a
// transient outage doesn't flap.
export async function probeVersions(): Promise<VersionState | null> {
    if (!(await which("git"))) return null;
    const inWt = await capture($`git rev-parse --is-inside-work-tree`);
    if (!inWt.ok) return null;

    const fetched = await capture($`git fetch --quiet --tags origin`);
    if (!fetched.ok) return null;

    const describe = await capture($`git describe --tags --abbrev=0 origin/main`);
    const latest = describe.ok ? describe.stdout.trim() : "";
    if (!latest) return null;

    const current = await readCurrentVersion();
    if (!current) return null;

    return { latest, current };
}

// True iff the latest tag (stripped of "v") differs from current.
// Doesn't enforce semver ordering — matches the bash original's
// exact-string compare. If a future release lands `v0.1.16` and
// someone manually edited panel config to `0.2.0`, we'd report a
// (spurious) upgrade-available — but that's the bash original's
// behaviour too.
export function upgradeAvailable(v: VersionState): boolean {
    return v.latest.replace(/^v/, "") !== v.current;
}
