// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/singbox_outbound_ipv4_only.ts — pure-TS
// port of ct fix recipe 10.
//
// Detect: sing-box is up, the host can NOT reach the public internet
// over IPv6, AND the rendered sing-box config does not carry an
// IPv4-preferring direct outbound strategy. Without that, outbound
// traffic to AAAA-heavy destinations can spend user-visible time in
// dead IPv6 attempts before falling back to IPv4.
//
// Fix: re-render the sing-box config from the current template (which
// emits prefer_ipv4 by default as of v0.4.9). If a legacy
// docker-compose.override.yml hotfix set
// ENABLE_DEPRECATED_LEGACY_DOMAIN_STRATEGY_OPTIONS, retire it and
// recreate sing-box so the env var disappears. Otherwise just
// restart sing-box.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";
import {
    readSingboxConfig,
    recreateSingbox,
    renderSingboxConfig,
    restartSingbox,
    singboxRunning,
} from "../../util/credential-control";

const DESCRIBE = `Your server can't reach the public internet over IPv6.

That's common on cloud providers (Vultr is the usual one) that
advertise IPv6 in the welcome email but don't actually route IPv6
traffic to the open internet. As a result, every time the proxy
tries to fetch a website that DNS resolves to an IPv6 address first,
the connection fails — and the Mac client sees the tunnel drop.

Symptom from the client side:
  - "Connected" indicator turns green for a moment
  - Then "connection reset" / "tunnel dropped"
  - Browsers can't load anything via the proxy

Fix: tell sing-box to prefer IPv4 when reaching the internet. We
ship a sing-box template (v0.4.9+) that emits the right directive.
This recipe re-runs the renderer so the running config picks up
the directive, then restarts sing-box once. Browsers / apps behind
the proxy work exactly the same after the fix — every website
reachable over IPv6 is also reachable over IPv4.

If you upgraded from v0.1.1 and have a docker-compose.override.yml
that sets ENABLE_DEPRECATED_LEGACY_DOMAIN_STRATEGY_OPTIONS=true as a
hotfix, this recipe also removes that file (no longer needed).`;

const OVERRIDE_PATH = "docker-compose.override.yml";
const LEGACY_ENV_FLAG = "ENABLE_DEPRECATED_LEGACY_DOMAIN_STRATEGY_OPTIONS";

async function hostHasIpv6(): Promise<boolean> {
    if (!(await which("curl"))) return false;
    const r = await capture($`curl -sS -6 --max-time 3 https://1.1.1.1/`);
    return r.ok;
}

async function configHasIpv4Strategy(): Promise<boolean> {
    const r = await readSingboxConfig();
    if (!r.ok) return false;
    try {
        const cfg = JSON.parse(r.stdout) as { outbounds?: Array<Record<string, unknown>> };
        const direct = cfg.outbounds?.find((o) => o["type"] === "direct" && o["tag"] === "direct");
        const strategy = direct?.["domain_strategy"];
        return strategy === "prefer_ipv4" || strategy === "ipv4_only";
    } catch {
        return false;
    }
}

async function detectIpv4Only(): Promise<boolean> {
    if (!(await singboxRunning())) return false;
    // Healthy IPv6 → recipe doesn't apply.
    if (await hostHasIpv6()) return false;
    // Already has the directive → renderer is up to date.
    if (await configHasIpv4Strategy()) return false;
    return true;
}

async function legacyOverridePresent(): Promise<boolean> {
    const f = Bun.file(OVERRIDE_PATH);
    if (!(await f.exists())) return false;
    const text = await f.text();
    return text.includes(LEGACY_ENV_FLAG);
}

export const recipe: Recipe = {
    slug: "singbox_outbound_ipv4_only",
    describe: async () => DESCRIBE,
    detect: detectIpv4Only,
    async fix() {
        const render = await renderSingboxConfig();
        if (!render.ok) {
            return {
                ok: false,
                detail: render.stderr.split("\n")[0] || "php artisan singbox:render failed",
            };
        }

        if (await legacyOverridePresent()) {
            // Retire the legacy override + recreate sing-box (not
            // restart) so the removed env var actually goes away.
            await capture($`rm -f ${OVERRIDE_PATH}`);
            await recreateSingbox();
        } else {
            await restartSingbox();
        }
        await new Promise((res) => setTimeout(res, 6000));
        return { ok: true };
    },
    async verify() {
        if (!(await configHasIpv4Strategy())) return false;
        return await singboxRunning();
    },
};
