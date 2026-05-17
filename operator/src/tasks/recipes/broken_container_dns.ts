// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/broken_container_dns.ts — pure-TS port of
// ct fix recipe 5.
//
// Detect: the panel container is running but can NOT reach 1.1.1.1 by
// hostname, yet CAN reach 1.0.0.1 by direct IP. That's the signature
// of broken container DNS (docker bridge NAT / iptables left in a bad
// state, usually after IPv6 disable). Fix: restart the docker daemon
// to rebuild bridge NAT cleanly.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `The panel container cannot resolve hostnames but CAN reach
public IPs directly. Docker bridge NAT or container DNS is
broken.

Typical causes: stale iptables rules after IPv6 disable,
broken /etc/resolv.conf inside the container, docker daemon
bridge interface in a bad state after a host network change.

Fix: restart the docker daemon. This regenerates the bridge
NAT + iptables rules cleanly. Containers auto-restart.`;

async function panelRunning(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await capture($`docker compose ps --status running panel`);
    return r.ok && /ct-panel/.test(r.stdout);
}

async function panelCanReach(target: string): Promise<boolean> {
    const cmd = `wget -q --timeout=3 --tries=1 -O /dev/null ${target}`;
    const r = await capture($`docker compose exec -T panel sh -c ${cmd}`);
    return r.ok;
}

async function detectBroken(): Promise<boolean> {
    if (!(await panelRunning())) return false;
    // If hostname resolution works, nothing to fix.
    if (await panelCanReach("https://1.1.1.1/")) return false;
    // Confirm it's DNS by checking that direct-IP traffic does work.
    if (!(await panelCanReach("https://1.0.0.1/"))) return false;
    return true;
}

export const recipe: Recipe = {
    slug: "broken_container_dns",
    describe: async () => DESCRIBE,
    detect: detectBroken,
    async fix() {
        const restart = await capture($`sudo systemctl restart docker`);
        if (!restart.ok) {
            return {
                ok: false,
                detail: restart.stderr.split("\n")[0] || "systemctl restart docker failed",
            };
        }
        await new Promise((res) => setTimeout(res, 8000));
        await capture($`docker compose up -d`);
        await new Promise((res) => setTimeout(res, 5000));
        return { ok: true };
    },
    async verify() {
        return !(await detectBroken());
    },
};
