// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/sing_box_doh_crash.ts — pure-TS recipe.
//
// Detect: sing-box container in Restarting state AND last log lines
// contain "missing domain resolver for domain server address". This
// is the sing-box 1.13 schema break for hostname-form DoH that v0.1.9
// fixed in the template, but the patch only applies to the renderer
// — operators on existing deploys still have the broken cached
// config in the singbox_config volume until next render.
//
// Fix: re-render via panel (picks up the v0.1.9 template) + restart
// sing-box. If render is unavailable, patch the config in place
// (replace dns.alidns.com with 1.1.1.1 — IP-form needs no
// domain_resolver).

import type { Recipe } from "./types";
import type { RunContext } from "../../runner/context";
import { $, capture, which } from "../../util/sh";
import {
    renderSingboxConfig,
    restartSingbox,
    singboxLogs,
    singboxState,
} from "../../util/credential-control";

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
    const state = await singboxState();
    if (state !== "restarting") return false;
    const logs = await singboxLogs(20, true);
    return logs.ok && /missing domain resolver/i.test(logs.stdout);
}

async function fixCrash(_ctx: RunContext): Promise<{ ok: boolean; detail?: string }> {
    // Try the proper path first: re-render via the panel.
    const render = await renderSingboxConfig();
    if (render.ok) {
        await restartSingbox();
        await new Promise((r) => setTimeout(r, 5000));
        return { ok: true };
    }
    // Fallback: patch the cached config to use 1.1.1.1 (IP-form).
    const patch = await capture(
        $`docker compose exec -T panel sed -i 's|"server": "dns.alidns.com"|"server": "1.1.1.1"|' /data/config/singbox.json`,
    );
    if (!patch.ok) {
        return { ok: false, detail: "render and in-place patch both failed" };
    }
    await restartSingbox();
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
