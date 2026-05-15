// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/sing_box_doh_crash.ts — pure-TS recipe.
//
// Detect: sing-box container in Restarting state AND last log lines
// contain "missing domain resolver for domain server address". This
// is the sing-box 1.13 schema break for hostname-form DoH that v0.1.9
// fixed in the template, but the patch only applies to the renderer
// — operators on existing deploys still have the broken cached
// config in the singbox_etc volume until next render.
//
// Fix: re-render via panel (picks up the v0.1.9 template) + restart
// sing-box. If render is unavailable, patch the config in place
// (replace dns.alidns.com with 1.1.1.1 — IP-form needs no
// domain_resolver).

import type { Recipe } from "./types";
import type { RunContext } from "../../runner/context";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `sing-box is crash-looping with:
    FATAL: create service: initialize DNS server[0]:
           missing domain resolver for domain server address

This is sing-box 1.13's strict DNS schema rejecting the hostname-form
DoH server in the cached config. The DB ships dns.alidns.com as the
default (chosen for GFW reachability); pre-v0.1.9 templates didn't
include a bootstrap resolver for it.

Fix: re-render the sing-box config (the v0.1.9+ template emits a
bootstrap DNS server) and restart sing-box. Idempotent. If
re-render isn't available (e.g. panel down), patch the cached
config in place to use 1.1.1.1 directly (IP-form needs no
domain_resolver). Either path produces a config sing-box accepts.`;

async function detectCrash(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const ps = await capture($`docker compose ps sing-box --format json`);
    if (!ps.ok) return false;
    let state = "";
    for (const line of ps.stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            const row = JSON.parse(t) as { State?: string };
            state = row.State ?? "";
        } catch {}
    }
    if (state !== "restarting") return false;
    const logs = await capture($`docker compose logs sing-box --tail=20 --no-color`);
    return logs.ok && /missing domain resolver/i.test(logs.stdout);
}

async function fixCrash(_ctx: RunContext): Promise<{ ok: boolean; detail?: string }> {
    // Try the proper path first: re-render via ct-server-core.
    const render = await capture(
        $`docker compose exec -T panel ct-server-core --json singbox render`,
    );
    if (render.ok) {
        await capture($`docker compose restart sing-box`);
        await new Promise((r) => setTimeout(r, 5000));
        return { ok: true };
    }
    // Fallback: patch the cached config to use 1.1.1.1 (IP-form).
    const patch = await capture(
        $`docker compose exec -T panel sed -i 's|"server": "dns.alidns.com"|"server": "1.1.1.1"|' /etc/sing-box/config.json`,
    );
    if (!patch.ok) {
        return { ok: false, detail: "render and in-place patch both failed" };
    }
    await capture($`docker compose restart sing-box`);
    await new Promise((r) => setTimeout(r, 5000));
    return { ok: true };
}

export const recipe: Recipe = {
    slug: "sing_box_doh_crash",
    describe: async () => DESCRIBE,
    detect: detectCrash,
    fix: fixCrash,
    async verify() {
        return !(await detectCrash());
    },
};
