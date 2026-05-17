// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/missing_tls_cert.ts — pure-TS port of
// ct fix recipe 8.
//
// Detect: sing-box logs show "no such file or directory" on a .crt
// path — caddy hasn't issued the cert yet so sing-box can't start
// its naive inbound. Fix: restart caddy to trigger an ACME retry,
// then wait ~90s for the cert to land.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `sing-box is restart-looping because Caddy hasn't yet obtained
the TLS cert for the proxy domain. sing-box reads the cert from
the shared /data/caddy/... volume; until Caddy issues it, the
file doesn't exist and sing-box can't start its naive inbound.

Fix: poke Caddy to retry ACME (it usually retries on a 60-120s
backoff). The fix restarts Caddy + waits up to 90 seconds for
the cert to land. If the underlying issue is DNS or port-80
unreachability, recipe ipv6_dns_unreachable is the more
appropriate fix and should run first.`;

async function detectMissing(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await capture($`docker compose logs --tail=30 sing-box`);
    if (!r.ok) return false;
    return /no such file or directory.*\.crt/.test(r.stdout + r.stderr);
}

export const recipe: Recipe = {
    slug: "missing_tls_cert",
    describe: async () => DESCRIBE,
    detect: detectMissing,
    async fix() {
        const r = await capture($`docker compose restart caddy`);
        if (!r.ok) {
            return {
                ok: false,
                detail: r.stderr.split("\n")[0] || "compose restart caddy failed",
            };
        }
        await new Promise((res) => setTimeout(res, 90000));
        return { ok: true };
    },
    async verify() {
        return !(await detectMissing());
    },
};
