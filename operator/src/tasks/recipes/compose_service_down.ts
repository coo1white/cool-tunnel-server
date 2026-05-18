// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/compose_service_down.ts — pure-TS port of
// ct fix recipe 2.
//
// Detect: any service declared in compose.yml is NOT in the running set
// right now. Fix: `docker compose up -d`.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

async function listMissing(): Promise<string[]> {
    if (!(await which("docker"))) return [];
    const declaredR = await capture($`docker compose config --services`);
    if (!declaredR.ok) return [];
    const declared = new Set(
        declaredR.stdout.split("\n").map((s) => s.trim()).filter(Boolean),
    );
    if (declared.size === 0) return [];
    const runningR = await capture($`docker compose ps --status running --services`);
    const running = new Set(
        runningR.ok ? runningR.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [],
    );
    return [...declared].filter((s) => !running.has(s)).sort();
}

function describeText(missing: string[]): string {
    const list = missing.length > 0 ? missing.join(", ") : "<probe failed>";
    return `One or more containers that the Cool Tunnel stack expects to be
running is currently NOT running.

Missing services: ${list}

What this means in practice:
  - If caddy is missing   -> host ports 80/443 are unbound; panel
    and proxy traffic both lose their public entry point.
  - If panel is missing   -> the admin UI is gone; proxy continues
    working until next render but new accounts can't be created.
  - If sing-box is missing -> the proxy itself is down.

Common cause: a previous deploy or host reboot left one service
stopped while the rest of the compose project stayed up. This recipe
is for the "container is just gone" case.

Fix: \`docker compose up -d\` brings every declared service back
to Up state. Existing services that are already healthy are
untouched (no-op).

Safe to run: no data loss, no config rewrite, no secret regen.`;
}

export const recipe: Recipe = {
    slug: "compose_service_down",
    async describe() {
        return describeText(await listMissing());
    },
    async detect() {
        return (await listMissing()).length > 0;
    },
    async fix() {
        const r = await capture($`docker compose up -d`);
        if (!r.ok) {
            return {
                ok: false,
                detail: r.stderr.split("\n").slice(0, 3).join(" / ") || "compose up failed",
            };
        }
        await new Promise((res) => setTimeout(res, 8000));
        return { ok: true };
    },
    async verify() {
        return (await listMissing()).length === 0;
    },
};
