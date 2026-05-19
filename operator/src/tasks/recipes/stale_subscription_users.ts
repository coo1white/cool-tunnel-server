// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/stale_subscription_users.ts — pure-TS recipe.
//
// Detect: sing-box config's users array contains the placeholder
// `__no_active_accounts__` AND the panel DB has at least one
// enabled proxy account. This means the renderer was last run when
// no accounts existed; subsequent account creation didn't trigger
// a fresh render. Symptom: macOS / sing-box client gets a 200 OK +
// padding + RST cover-site response because no valid user is
// loaded server-side.
//
// Fix: trigger a re-render via the panel, then restart sing-box.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";
import { readSingboxConfig, renderSingboxConfig, restartSingbox } from "../../util/credential-control";

const DESCRIBE = `sing-box's cached config still has the placeholder user
\`__no_active_accounts__\`, but the panel DB has at least one
enabled proxy account. The render was last performed when no
accounts existed, and creating accounts didn't trigger a re-render.

Symptom: client connects, TLS handshake succeeds, server returns
\`HTTP/1.1 200 OK\\r\\nPadding: <random>\\r\\n\\r\\n\` and resets.
That is the project's anti-fingerprint cover-site response — what
you see when the user / password don't match any active account.

Fix: \`docker compose exec panel php artisan singbox:render --if-changed\`
to render with the current DB state, then restart sing-box.`;

async function configHasPlaceholder(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await readSingboxConfig();
    return r.ok && /__no_active_accounts__/.test(r.stdout);
}

async function dbHasEnabledAccount(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await capture(
        $`docker compose exec -T panel php artisan tinker --execute=${"echo \\App\\Models\\ProxyAccount::where('enabled',1)->count();"}`,
    );
    if (!r.ok) return false;
    // Tinker prints a number; trim and parse.
    const n = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(n) && n > 0;
}

export const recipe: Recipe = {
    slug: "stale_subscription_users",
    describe: async () => DESCRIBE,
    async detect() {
        return (await configHasPlaceholder()) && (await dbHasEnabledAccount());
    },
    async fix() {
        const r = await renderSingboxConfig();
        if (!r.ok) {
            return {
                ok: false,
                detail: r.stderr.split("\n")[0] ?? "php artisan singbox:render failed",
            };
        }
        await restartSingbox();
        await new Promise((res) => setTimeout(res, 5000));
        return { ok: true };
    },
    async verify() {
        return !(await configHasPlaceholder());
    },
};
