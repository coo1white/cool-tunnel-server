// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/singbox_outbound_ipv4_only.ts — pure-TS
// port of ct fix recipe 10.
//
// Detect: sing-box is up, the host can NOT reach the public internet
// over IPv6, AND the rendered sing-box config lacks the v0.1.2+
// "domain_resolver" directive — i.e. outbound traffic to AAAA records
// will fail and the client will see a post-CONNECT reset.
//
// Fix: re-render the sing-box config from the current template (which
// emits domain_resolver as of v0.1.2). If a legacy
// docker-compose.override.yml hotfix set
// ENABLE_DEPRECATED_LEGACY_DOMAIN_STRATEGY_OPTIONS, retire it and
// recreate sing-box so the env var disappears. Otherwise just
// restart sing-box.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

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
ship a sing-box template (v0.1.2+) that emits the right directive.
This recipe re-runs the renderer so the running config picks up
the directive, then restarts sing-box once. Browsers / apps behind
the proxy work exactly the same after the fix — every website
reachable over IPv6 is also reachable over IPv4.

If you upgraded from v0.1.1 and have a docker-compose.override.yml
that sets ENABLE_DEPRECATED_LEGACY_DOMAIN_STRATEGY_OPTIONS=true as a
hotfix, this recipe also removes that file (no longer needed).`;

const CONFIG_PATH = "/var/lib/docker/volumes/cool-tunnel-server_singbox_etc/_data/config.json";
const OVERRIDE_PATH = "docker-compose.override.yml";
const LEGACY_ENV_FLAG = "ENABLE_DEPRECATED_LEGACY_DOMAIN_STRATEGY_OPTIONS";

async function singBoxRunning(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await capture($`docker compose ps --status running sing-box`);
    return r.ok && r.stdout.includes("ct-singbox");
}

async function hostHasIpv6(): Promise<boolean> {
    if (!(await which("curl"))) return false;
    const r = await capture($`curl -sS -6 --max-time 3 https://1.1.1.1/`);
    return r.ok;
}

async function configHasDomainResolver(): Promise<boolean> {
    const f = Bun.file(CONFIG_PATH);
    if (!(await f.exists())) return false;
    const text = await f.text();
    return text.includes("domain_resolver");
}

async function detectIpv4Only(): Promise<boolean> {
    if (!(await singBoxRunning())) return false;
    // Healthy IPv6 → recipe doesn't apply.
    if (await hostHasIpv6()) return false;
    // Config file must exist (otherwise we can't reason about it).
    const cfg = Bun.file(CONFIG_PATH);
    if (!(await cfg.exists())) return false;
    // Already has the directive → renderer is up to date.
    if (await configHasDomainResolver()) return false;
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
        const render = await capture(
            $`docker compose exec -T panel ct-server-core --json singbox render`,
        );
        if (!render.ok) {
            return {
                ok: false,
                detail: render.stderr.split("\n")[0] || "ct-server-core singbox render failed",
            };
        }

        if (await legacyOverridePresent()) {
            // Retire the legacy override + recreate sing-box (not
            // restart) so the removed env var actually goes away.
            await capture($`rm -f ${OVERRIDE_PATH}`);
            await capture($`docker compose up -d sing-box`);
        } else {
            await capture($`docker compose restart sing-box`);
        }
        await new Promise((res) => setTimeout(res, 6000));
        return { ok: true };
    },
    async verify() {
        if (!(await configHasDomainResolver())) return false;
        return await singBoxRunning();
    },
};
