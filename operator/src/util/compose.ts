// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/compose.ts — docker-compose helpers.
//
// Mirrors a small subset of scripts/lib.sh: composeProjectName()
// (used to resolve project-prefixed volume names) and a couple of
// state probes.

import { $, capture } from "./sh";

// Resolve docker-compose's project name for the current cwd.
// Tries `docker compose config --format json` first (the canonical
// source), then falls back to compose v2's default rule: basename
// of the project directory, lowercased and stripped of any
// non-alphanumeric chars. Matches scripts/lib.sh::compose_project_name.
export async function composeProjectName(cwd: string = process.cwd()): Promise<string> {
    const r = await capture($`docker compose config --format json`.cwd(cwd));
    if (r.ok) {
        try {
            const cfg = JSON.parse(r.stdout) as { name?: unknown };
            if (typeof cfg.name === "string" && cfg.name.length > 0) {
                return cfg.name;
            }
        } catch {
            // fall through to basename rule
        }
    }
    return basenameProjectName(cwd);
}

// Compose v2's default project-name derivation. Exported for tests.
export function basenameProjectName(dir: string): string {
    const base = dir.replace(/\/+$/, "").split("/").pop() ?? "";
    return base.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

// True iff the named compose service is currently running.
export async function serviceRunning(service: string): Promise<boolean> {
    const r = await capture($`docker compose ps -q ${service}`);
    return r.ok && r.stdout.trim().length > 0;
}
