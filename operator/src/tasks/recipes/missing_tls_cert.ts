// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/missing_tls_cert.ts — Caddy ACME repair.
//
// Detect: the panel-domain certificate is missing from caddy_data or
// caddy itself is NG. Fix: make sure the panel has rendered the v0.4+
// Caddyfile, recreate/restart Caddy, then wait for the panel-domain
// cert to land in Caddy's ACME storage.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";
import { loadDotenv, mergeEnv } from "../../util/env";
import type { RunContext } from "../../runner/context";
import { waitFor } from "../../util/wait";

const DESCRIBE = `Caddy has not obtained the panel-domain TLS cert yet,
or the panel cannot reach the Caddy service over the compose network.
In v0.4+ only the panel subdomain uses ACME; the proxy path is
VLESS+Reality and does not need a Caddy certificate.

Fix: re-render the Caddyfile from the DB, remove a stale ct-caddy
container if Docker left one Created/Exited/Dead, start/restart Caddy,
then wait up to 90 seconds for the panel certificate to appear under
caddy_data. If DNS or inbound TCP/80 is still blocked, Caddy logs will
show the ACME challenge failure and this recipe will time out cleanly.`;

export async function panelDomain(ctx: RunContext): Promise<string> {
    const loaded = await loadDotenv([`${ctx.cwd}/.env`, `${ctx.cwd}/../.env`]);
    const env = mergeEnv(process.env as Record<string, string>, loaded?.env ?? null);
    return (env["PANEL_DOMAIN"] || (env["DOMAIN"] ? `panel.${env["DOMAIN"]}` : "")).trim();
}

async function caddyState(): Promise<string> {
    if (!(await which("docker"))) return "";
    const r = await capture($`docker inspect -f ${"{{.State.Status}}"} ct-caddy`);
    return r.ok ? r.stdout.trim() : "";
}

async function certPath(domain: string): Promise<string> {
    if (!domain || !(await which("docker"))) return "";
    const certName = `${domain}.crt`;
    const r = await capture(
        $`docker compose exec -T caddy find /data/caddy/certificates -name ${certName} -print -quit`,
    );
    return r.ok ? r.stdout.trim() : "";
}

async function caddyComponentNg(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await capture(
        $`docker compose exec -T panel ct-server-core component check --manifests /srv/manifests`,
    );
    if (!r.ok) return false;
    return /^\s*NG\s+caddy\b/m.test(r.stdout + r.stderr);
}

export async function detectMissing(ctx: RunContext): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const domain = await panelDomain(ctx);
    if (!domain) return false;
    const state = await caddyState();
    if (state === "created" || state === "exited" || state === "dead") return true;
    if (!(await certPath(domain))) return true;
    return await caddyComponentNg();
}

export const recipe: Recipe = {
    slug: "missing_tls_cert",
    describe: async () => DESCRIBE,
    detect: detectMissing,
    async fix(ctx) {
        const domain = await panelDomain(ctx);
        if (!domain) {
            return { ok: false, detail: "PANEL_DOMAIN and DOMAIN are unset" };
        }

        const render = await capture($`docker compose exec -T panel ct-server-core caddyfile render`);
        if (!render.ok) {
            return {
                ok: false,
                detail: render.stderr.split("\n")[0] || "caddyfile render failed",
            };
        }

        const state = await caddyState();
        if (state === "created" || state === "exited" || state === "dead") {
            const rm = await capture($`docker rm -f ct-caddy`);
            if (!rm.ok) return { ok: false, detail: rm.stderr.split("\n")[0] || "docker rm ct-caddy failed" };
            const up = await capture($`docker compose up -d caddy`);
            if (!up.ok) return { ok: false, detail: up.stderr.split("\n")[0] || "compose up caddy failed" };
        } else if (state === "running") {
            const restart = await capture($`docker compose restart caddy`);
            if (!restart.ok) return { ok: false, detail: restart.stderr.split("\n")[0] || "compose restart caddy failed" };
        } else {
            const up = await capture($`docker compose up -d caddy`);
            if (!up.ok) return { ok: false, detail: up.stderr.split("\n")[0] || "compose up caddy failed" };
        }

        const ok = await waitFor({
            label: `Caddy panel cert for ${domain}`,
            maxAttempts: 45,
            intervalMs: 2000,
            probe: async () => Boolean(await certPath(domain)),
            onTimeout: () => undefined,
        });
        if (!ok) {
            return {
                ok: false,
                detail: `timed out waiting for ${domain}.crt; check docker compose logs --tail=120 caddy`,
            };
        }
        return { ok };
    },
    async verify(ctx) {
        return !(await detectMissing(ctx));
    },
};
