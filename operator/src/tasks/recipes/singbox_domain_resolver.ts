// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/singbox_domain_resolver.ts — pure-TS port
// of scripts/fix.sh recipe 9.
//
// Detect: sing-box logs show "missing domain resolver for domain
// server address" — sing-box 1.13+ rejects DoH resolvers that use a
// hostname without a domain_resolver bootstrap. Fix: set the panel's
// anti_tracking_doh_resolver to the IP-form DoH endpoint, re-render
// sing-box config, restart sing-box.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `sing-box 1.13+ rejects DoH resolvers that use a hostname
without an explicit "domain_resolver" bootstrap. The panel's
anti_tracking_doh_resolver setting in the DB is currently a
domain-form URL (e.g. https://dns.alidns.com/dns-query).

Fix: flip the DoH resolver to an IP-based DoH endpoint
(https://1.1.1.1/dns-query). sing-box accepts that without a
domain_resolver field. The renderer rebuilds config.json + the
container restarts.

After the fix you can later switch back to a domain-form
resolver once the panel renderer is updated to emit
domain_resolver bootstrap entries (tracked separately).`;

async function detectMissingResolver(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await capture($`docker compose logs --tail=30 sing-box`);
    if (!r.ok) return false;
    return /missing domain resolver for domain server address/.test(r.stdout + r.stderr);
}

// PHP source for artisan tinker. Single backslashes — the snippet is
// passed as a single argv (no shell interpolation), so PHP receives
// these characters verbatim and parses \App\Models\ServerConfig as
// the canonical namespaced class.
const SET_IP_RESOLVER_PHP = `
$c = \\App\\Models\\ServerConfig::current();
$c->anti_tracking_doh_resolver = "https://1.1.1.1/dns-query";
$c->save();
`;

export const recipe: Recipe = {
    slug: "singbox_domain_resolver",
    describe: async () => DESCRIBE,
    detect: detectMissingResolver,
    async fix() {
        const setR = await capture(
            $`docker compose exec -T panel php artisan tinker --execute=${SET_IP_RESOLVER_PHP}`,
        );
        if (!setR.ok) {
            return {
                ok: false,
                detail: setR.stderr.split("\n")[0] || "artisan tinker (set DoH resolver) failed",
            };
        }
        const render = await capture(
            $`docker compose exec -T panel ct-server-core --json singbox render`,
        );
        if (!render.ok) {
            return {
                ok: false,
                detail: render.stderr.split("\n")[0] || "ct-server-core singbox render failed",
            };
        }
        const restart = await capture($`docker compose restart sing-box`);
        if (!restart.ok) {
            return {
                ok: false,
                detail: restart.stderr.split("\n")[0] || "compose restart sing-box failed",
            };
        }
        await new Promise((res) => setTimeout(res, 8000));
        return { ok: true };
    },
    async verify() {
        return !(await detectMissingResolver());
    },
};
