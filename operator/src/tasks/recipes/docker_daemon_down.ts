// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/docker_daemon_down.ts — pure-TS port of
// ct fix recipe 1.
//
// Detect: `docker info` fails. Fix: systemctl start docker + enable +
// bring the compose stack back. Idempotent; systemctl start/enable
// are no-ops on already-healthy systems.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `The Docker daemon on this host is not running.

Without a running Docker daemon, NOTHING in the Cool Tunnel stack
can start (every service runs in a container). On Debian / Ubuntu
this usually happens because:
  - You installed docker.io but never enabled the service.
  - The host rebooted and docker was not enabled at boot.
  - Someone ran \`systemctl stop docker\` and forgot to restart it.

Fix: start the docker service + enable it for next boot. Then
re-run the compose stack so the cool-tunnel containers come up.

Safe to run regardless of state — \`systemctl start\` is a no-op on
an already-running daemon, \`systemctl enable\` is a no-op on
already-enabled. No data loss.`;

async function detectDown(): Promise<boolean> {
    // Can't fix what isn't installed — leave that case to install.sh.
    if (!(await which("docker"))) return false;
    const r = await capture($`docker info`);
    return !r.ok;
}

export const recipe: Recipe = {
    slug: "docker_daemon_down",
    describe: async () => DESCRIBE,
    detect: detectDown,
    async fix() {
        const start = await capture($`sudo systemctl start docker`);
        if (!start.ok) {
            return {
                ok: false,
                detail: start.stderr.split("\n")[0] || "systemctl start docker failed",
            };
        }
        // enable failure is non-fatal — start succeeded already.
        await capture($`sudo systemctl enable docker`);
        await new Promise((r) => setTimeout(r, 4000));
        await capture($`docker compose up -d`);
        await new Promise((r) => setTimeout(r, 8000));
        return { ok: true };
    },
    async verify() {
        return !(await detectDown());
    },
};
