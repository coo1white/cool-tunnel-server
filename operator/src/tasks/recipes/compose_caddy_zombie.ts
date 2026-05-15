// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/compose_caddy_zombie.ts — pure-TS recipe.
//
// Detect: ct-caddy container exists in non-Running state
// (Created / Exited / Dead). Docker reserves the host :80 port at
// container CREATE time, so a non-Running ct-caddy still holds the
// reservation. Subsequent `compose up -d caddy` hits
// "bind 0.0.0.0:80: address already in use" forever, even though
// `ss -tlnp` shows nothing actually listening.
//
// Fix: `docker rm -f ct-caddy` then `compose up -d caddy` — fresh
// container, fresh port allocation.
//
// v0.1.9's install.sh already does this preemptively in step 12.
// This recipe is for operators who hit the state via other paths
// (manual `docker compose stop caddy` mid-deploy, OOM kill, etc.).

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `ct-caddy is in a non-Running state with a stuck port :80
reservation. Symptom you'll see if you try to compose up -d caddy:

    Error response from daemon: failed to set up container networking:
    driver failed programming external connectivity on endpoint
    ct-caddy: failed to bind host port 0.0.0.0:80/tcp:
    address already in use

\`ss -tlnp | grep :80\` will show nothing — the port isn't actually
listening, just reserved by docker's port manager because the
container was successfully Created at some point but never reached
Running.

Fix: \`docker rm -f ct-caddy\` to release the reservation, then
\`docker compose up -d caddy\` to create a fresh container.`;

async function getState(): Promise<string> {
    if (!(await which("docker"))) return "";
    const r = await capture($`docker inspect -f ${"{{.State.Status}}"} ct-caddy`);
    return r.ok ? r.stdout.trim() : "";
}

export const recipe: Recipe = {
    slug: "compose_caddy_zombie",
    describe: async () => DESCRIBE,
    async detect() {
        const state = await getState();
        return state === "created" || state === "exited" || state === "dead";
    },
    async fix() {
        const rm = await capture($`docker rm -f ct-caddy`);
        if (!rm.ok) return { ok: false, detail: rm.stderr.split("\n")[0] ?? "docker rm failed" };
        await new Promise((r) => setTimeout(r, 1000));
        const up = await capture($`docker compose up -d caddy`);
        if (!up.ok) {
            return { ok: false, detail: up.stderr.split("\n")[0] ?? "compose up failed" };
        }
        await new Promise((r) => setTimeout(r, 3000));
        return { ok: true };
    },
    async verify() {
        const state = await getState();
        return state === "running" || state === "";
    },
};
