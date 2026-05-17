// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/panel_restart_loop.ts — pure-TS port of
// ct fix recipe 11.
//
// Detect: `docker compose ps panel` shows Restarting or Created.
// Fix: rebuild the image (no-op if cached) and force-recreate the
// container, then wait up to 30s for it to reach Up/healthy.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `The panel container is restart-looping (Docker shows "Restarting"
or "Created" instead of "Up"). The panel is the Laravel admin UI;
when it loops, the web UI is down, account changes don't save, and
new proxy users can't be created.

Common causes:
  - The panel image is older than the bug-fix in the source tree
    (you ran \`git pull\` but not \`docker compose build\`).
  - A transient composer install error mid-build.
  - A missing APP_KEY or unmigrated database schema (we have
    a separate recipe for the latter; pending_migrations).

Fix: pull/rebuild the panel image and recreate the container. Safe
to run — Docker keeps the old container until the new one comes up,
so there is no downtime window where the OLD panel is also gone.

After the recreate, the recipe waits up to 30 seconds for the
container to reach "Up healthy" before declaring success.`;

async function panelLooping(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await capture($`docker compose ps panel`);
    return r.ok && /Restarting|Created/.test(r.stdout);
}

async function panelUp(): Promise<boolean> {
    const r = await capture($`docker compose ps panel`);
    if (!r.ok) return false;
    return /Up.*healthy|Up\s+\d+/.test(r.stdout);
}

export const recipe: Recipe = {
    slug: "panel_restart_loop",
    describe: async () => DESCRIBE,
    detect: panelLooping,
    async fix() {
        // Build is a fast no-op when nothing changed; failure is
        // non-fatal because force-recreate from the existing image
        // is still a useful recovery path.
        await capture($`docker compose build panel`);
        const up = await capture($`docker compose up -d --force-recreate panel`);
        if (!up.ok) {
            return {
                ok: false,
                detail: up.stderr.split("\n")[0] || "compose up --force-recreate panel failed",
            };
        }
        for (let i = 0; i < 15; i++) {
            await new Promise((res) => setTimeout(res, 2000));
            if (await panelUp()) return { ok: true };
        }
        return { ok: false, detail: "panel did not reach Up state within 30s" };
    },
    async verify() {
        return !(await panelLooping());
    },
};
