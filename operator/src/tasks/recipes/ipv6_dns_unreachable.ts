// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/ipv6_dns_unreachable.ts — pure-TS port of
// scripts/fix.sh recipe 6.
//
// Detect: caddy is running AND its recent logs show "network is
// unreachable" against an IPv6 DNS server (Vultr-style: provider
// advertises IPv6 but doesn't route it, and /etc/resolv.conf still
// points at an IPv6 nameserver).
//
// Fix: 3-layer IPv6 disable —
//   1. sysctl   — disable IPv6 in the kernel (persistent)
//   2. resolv.conf — pin IPv4-only nameservers
//   3. docker daemon.json — "ipv6": false + explicit IPv4 DNS
// then restart docker and bring the stack back up.
//
// System-config writes use Bun.write() to a private /tmp staging
// path + `sudo cp` to land the file — avoids the heredoc-via-tee
// quoting dance and keeps the canonical content in TypeScript.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `Caddy's ACME process is failing because the host's IPv6 path is
unreachable but /etc/resolv.conf points at an IPv6 DNS server.
Common on Vultr instances: provider advertises IPv6 but doesn't
actually route it.

Fix (3-layer IPv6 disable):
  1. sysctl   — disable IPv6 in the kernel (persistent)
  2. resolv.conf — pin IPv4-only nameservers
  3. docker daemon.json — "ipv6": false + explicit IPv4 DNS

Restarts the docker daemon afterwards so containers pick up
the new config.`;

const SYSCTL_CONF = `net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 1
`;

const RESOLV_CONF = `nameserver 1.1.1.1
nameserver 8.8.8.8
options single-request-reopen
`;

const DOCKER_DAEMON_JSON = `{
  "ipv6": false,
  "dns": ["1.1.1.1", "8.8.8.8"]
}
`;

const IPV6_LOG_RE = /network is unreachable.*\[[0-9a-fA-F:]+\]:53|dial udp \[[0-9a-fA-F:]+\]:53/;

async function caddyRunning(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await capture($`docker compose ps --status running caddy`);
    return r.ok && r.stdout.includes("ct-caddy");
}

async function caddyLogsShowIpv6Failure(tail: number): Promise<boolean> {
    const r = await capture($`docker compose logs --tail=${tail} caddy`);
    if (!r.ok) return false;
    return IPV6_LOG_RE.test(r.stdout + r.stderr);
}

async function detectIpv6(): Promise<boolean> {
    if (!(await caddyRunning())) return false;
    return await caddyLogsShowIpv6Failure(60);
}

async function writeAsRoot(targetPath: string, content: string) {
    const tmp = `/tmp/ct-operator-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    await Bun.write(tmp, content);
    try {
        return await capture($`sudo cp ${tmp} ${targetPath}`);
    } finally {
        await capture($`rm -f ${tmp}`);
    }
}

export const recipe: Recipe = {
    slug: "ipv6_dns_unreachable",
    describe: async () => DESCRIBE,
    detect: detectIpv6,
    async fix() {
        const sysctl = await writeAsRoot("/etc/sysctl.d/99-disable-ipv6.conf", SYSCTL_CONF);
        if (!sysctl.ok) {
            return {
                ok: false,
                detail: sysctl.stderr.split("\n")[0] || "writing sysctl.d/99-disable-ipv6.conf failed",
            };
        }
        await capture($`sudo sysctl --system`);

        // Best-effort backup of the existing resolv.conf (-n: don't
        // clobber an earlier backup).
        await capture($`sudo cp -n /etc/resolv.conf /etc/resolv.conf.bak`);
        const resolv = await writeAsRoot("/etc/resolv.conf", RESOLV_CONF);
        if (!resolv.ok) {
            return {
                ok: false,
                detail: resolv.stderr.split("\n")[0] || "writing /etc/resolv.conf failed",
            };
        }

        await capture($`sudo mkdir -p /etc/docker`);
        const daemon = await writeAsRoot("/etc/docker/daemon.json", DOCKER_DAEMON_JSON);
        if (!daemon.ok) {
            return {
                ok: false,
                detail: daemon.stderr.split("\n")[0] || "writing /etc/docker/daemon.json failed",
            };
        }

        const restart = await capture($`sudo systemctl restart docker`);
        if (!restart.ok) {
            return {
                ok: false,
                detail: restart.stderr.split("\n")[0] || "systemctl restart docker failed",
            };
        }
        await new Promise((res) => setTimeout(res, 10000));
        await capture($`docker compose up -d`);
        await new Promise((res) => setTimeout(res, 30000));
        return { ok: true };
    },
    async verify() {
        // Verify against a shorter log window (recent activity only) —
        // older IPv6 failures from before the fix can still be in
        // tail=60, but tail=20 should be post-restart.
        if (!(await caddyRunning())) return true;
        return !(await caddyLogsShowIpv6Failure(20));
    },
};
