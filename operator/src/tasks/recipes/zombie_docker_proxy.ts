// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/zombie_docker_proxy.ts — pure-TS port of
// ct fix recipe 3.
//
// Detect: docker-proxy is bound to :80 or :443 on the host but no
// running container is actually publishing those ports. Fix: restart
// the docker daemon so iptables NAT + port publishers are rebuilt.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `docker-proxy is bound to :80 or :443 on the host but no
matching running container is publishing those ports.

Typical cause: a previous \`docker compose up\` attempt failed
mid-flight — the container died but the host-side port publisher
orphaned. Subsequent \`compose up\` then fails with
"Bind for 0.0.0.0:80 failed: port is already allocated".

Fix: restart the docker daemon. This regenerates iptables NAT
rules and cleans orphan proxies. Currently-running containers
respawn under their restart policies and do NOT lose data.`;

async function dockerProxyHoldsPort(): Promise<boolean> {
    if (!(await which("ss"))) return false;
    const ss = await capture($`sudo ss -ltnp`);
    if (!ss.ok) return false;
    return /docker-proxy.*:80\b|docker-proxy.*:443\b/.test(ss.stdout);
}

async function liveCompose80Or443(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await capture($`docker ps --format ${"{{.Status}} {{.Ports}}"}`);
    if (!r.ok) return false;
    return /Up.*0\.0\.0\.0:(80|443)->/m.test(r.stdout);
}

async function detectZombie(): Promise<boolean> {
    if (!(await dockerProxyHoldsPort())) return false;
    // If something is genuinely listening, the proxy is legitimate.
    if (await liveCompose80Or443()) return false;
    return true;
}

export const recipe: Recipe = {
    slug: "zombie_docker_proxy",
    describe: async () => DESCRIBE,
    detect: detectZombie,
    async fix() {
        const r = await capture($`sudo systemctl restart docker`);
        if (!r.ok) {
            return {
                ok: false,
                detail: r.stderr.split("\n")[0] || "systemctl restart docker failed",
            };
        }
        await new Promise((res) => setTimeout(res, 8000));
        return { ok: true };
    },
    async verify() {
        return !(await detectZombie());
    },
};
