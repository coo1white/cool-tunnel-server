// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/foreign_container_ports.ts — pure-TS port
// of ct fix recipe 4.
//
// Detect: a docker container that is NOT part of the cool-tunnel-server
// compose project (name doesn't start with "ct-") is publishing host
// :80 or :443. Fix: stop + remove each offender so caddy / haproxy
// can bind those ports.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

async function listForeign(): Promise<string[]> {
    if (!(await which("docker"))) return [];
    const r = await capture($`docker ps --format ${"{{.Names}}\t{{.Ports}}"}`);
    if (!r.ok) return [];
    const out: string[] = [];
    for (const line of r.stdout.split("\n")) {
        if (!line) continue;
        const [name, ports = ""] = line.split("\t");
        if (!name || name.startsWith("ct-")) continue;
        if (/0\.0\.0\.0:(80|443)->/.test(ports)) out.push(name);
    }
    return out;
}

function describeText(foreign: string[]): string {
    const list = foreign.length > 0 ? foreign.join(", ") : "<probe failed>";
    return `A docker container that is NOT part of cool-tunnel-server is
binding host port :80 or :443 to the public interface.

Foreign container(s) detected: ${list}

This blocks cool-tunnel's Caddy / HAProxy from starting because
:80 / :443 are already taken.

Fix: stop + remove the foreign container. If you actually want
to keep it running, the cool-tunnel stack will NEVER work on
this host (port conflict) and you should deploy cool-tunnel on
a different VPS instead.

The fix runs:
  docker stop <foreign>
  docker rm <foreign>`;
}

export const recipe: Recipe = {
    slug: "foreign_container_ports",
    async describe() {
        return describeText(await listForeign());
    },
    async detect() {
        return (await listForeign()).length > 0;
    },
    async fix() {
        const foreign = await listForeign();
        if (foreign.length === 0) {
            return { ok: false, detail: "no foreign containers to remove" };
        }
        for (const name of foreign) {
            process.stderr.write(`      stopping + removing: ${name}\n`);
            await capture($`docker stop ${name}`);
            await capture($`docker rm ${name}`);
        }
        return { ok: true };
    },
    async verify() {
        return (await listForeign()).length === 0;
    },
};
