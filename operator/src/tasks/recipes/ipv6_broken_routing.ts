// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/ipv6_broken_routing.ts — pure-TS recipe.
//
// Detect: host has no global IPv6 address AND `/etc/sysctl.d/
// 99-disable-ipv6.conf` is missing. Common on cheap VPSes (Vultr,
// RackNerd, etc) where IPv6 is advertised in the kernel but has no
// working route. Docker buildkit prefers IPv6 outbound and dies on
// static.rust-lang.org with `Network unreachable` during the Rust
// build step.
//
// Fix: write sysctl + daemon.json to permanently disable IPv6
// (same logic as scripts/lib.sh::disable_ipv6_if_broken). Restart
// docker daemon so the new settings take effect.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `Host has no global IPv6 address but IPv6 is enabled in the
kernel, and /etc/sysctl.d/99-disable-ipv6.conf is missing. Common on
cheap VPSes (Vultr, RackNerd, RipperNet, …) where the provider
advertises IPv6 but routes it nowhere.

Symptom: docker buildkit fails the Rust build step on
\`static.rust-lang.org\` with:
    error: failed to download file ... Network unreachable (os error 101)

Fix: write a sysctl override + docker daemon.json to permanently
disable IPv6, then restart docker. After this, buildkit only uses
IPv4 — Rust toolchain download succeeds.

Skip with CT_SKIP_IPV6_AUTO_DISABLE=1 if your IPv6 actually works.`;

async function hasGlobalIPv6(): Promise<boolean> {
    if (!(await which("ip"))) return true; // Can't tell — assume OK.
    const r = await capture($`ip -6 addr show scope global`);
    return r.ok && /inet6/.test(r.stdout);
}

async function sysctlConfigPresent(): Promise<boolean> {
    return Bun.file("/etc/sysctl.d/99-disable-ipv6.conf").exists();
}

export const recipe: Recipe = {
    slug: "ipv6_broken_routing",
    describe: async () => DESCRIBE,
    async detect() {
        if (process.env["CT_SKIP_IPV6_AUTO_DISABLE"] === "1") return false;
        if (await sysctlConfigPresent()) return false;
        return !(await hasGlobalIPv6());
    },
    async fix() {
        // Need to write to /etc/sysctl.d/ — that requires root.
        const isRoot = (await capture($`id -u`)).stdout.trim() === "0";
        const sudo = isRoot ? "" : "sudo ";
        const sysctl = `net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 1
`;
        const writeS = await capture(
            $`bash -c ${`${sudo}tee /etc/sysctl.d/99-disable-ipv6.conf >/dev/null <<'EOF'\n${sysctl}EOF`}`,
        );
        if (!writeS.ok) return { ok: false, detail: "could not write sysctl.d/99-disable-ipv6.conf" };
        await capture($`bash -c ${`${sudo}sysctl --system >/dev/null 2>&1`}`);
        // daemon.json — don't clobber an existing one.
        const daemonExists = await Bun.file("/etc/docker/daemon.json").exists();
        if (!daemonExists) {
            const dj = `{
  "ipv6": false,
  "dns": ["1.1.1.1", "8.8.8.8"]
}
`;
            await capture($`bash -c ${`${sudo}mkdir -p /etc/docker`}`);
            await capture(
                $`bash -c ${`${sudo}tee /etc/docker/daemon.json >/dev/null <<'EOF'\n${dj}EOF`}`,
            );
            await capture($`bash -c ${`${sudo}systemctl restart docker >/dev/null 2>&1 || true`}`);
        }
        return { ok: true };
    },
    async verify() {
        return sysctlConfigPresent();
    },
};
