// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/haproxy_backend_dns.ts — pure-TS port of
// ct fix recipe 7.
//
// Detect: haproxy is Restarting/Created AND its recent logs complain
// it cannot resolve "caddy" or "sing-box" via compose's internal DNS.
// Fix: bring caddy + sing-box up first, then restart haproxy.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `HAProxy is restart-looping because it cannot resolve its
upstream service hostnames ('caddy', 'sing-box') from compose's
internal DNS. Usually means those services aren't running yet
(chicken-and-egg startup ordering, exposed when caddy or
sing-box dies mid-init).

Fix: bring caddy + sing-box up first, then restart haproxy.`;

async function haproxyRestarting(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await capture($`docker compose ps haproxy`);
    return r.ok && /Restarting|Created/.test(r.stdout);
}

async function logsShowDnsFailure(): Promise<boolean> {
    const r = await capture($`docker compose logs --tail=30 haproxy`);
    if (!r.ok) return false;
    return /could not resolve address '(caddy|sing-box)'/.test(r.stdout + r.stderr);
}

async function detectDns(): Promise<boolean> {
    if (!(await haproxyRestarting())) return false;
    return await logsShowDnsFailure();
}

export const recipe: Recipe = {
    slug: "haproxy_backend_dns",
    describe: async () => DESCRIBE,
    detect: detectDns,
    async fix() {
        const up = await capture($`docker compose up -d caddy sing-box`);
        if (!up.ok) {
            return {
                ok: false,
                detail: up.stderr.split("\n")[0] || "compose up caddy+sing-box failed",
            };
        }
        await new Promise((res) => setTimeout(res, 10000));
        await capture($`docker compose restart haproxy`);
        await new Promise((res) => setTimeout(res, 5000));
        return { ok: true };
    },
    async verify() {
        const r = await capture($`docker compose ps haproxy`);
        return r.ok && /Up.*healthy/.test(r.stdout);
    },
};
