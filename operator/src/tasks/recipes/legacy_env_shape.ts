// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/legacy_env_shape.ts — pure-TS port of
// scripts/fix.sh recipe 16.
//
// Detect: .env has the pre-v0.0.68 APP_URL shape using ${DOMAIN}
// (apex hostname) instead of ${PANEL_DOMAIN}. Fix: delegate to
// scripts/update.sh which has the canonical idempotent rewrite.

import type { Recipe } from "./types";
import { $, capture } from "../../util/sh";

const DESCRIBE = `Your .env file uses the pre-v0.0.68 APP_URL shape:

  APP_URL=https://\${DOMAIN}/admin

This points the panel at the proxy apex hostname instead of
the dedicated panel subdomain, which causes Livewire to return
'419 PAGE EXPIRED' on every form submit (browser Origin header
mismatch vs the configured app URL host).

Fix: rewrite APP_URL to use \${PANEL_DOMAIN} instead. This is
exactly the auto-migration update.sh does on every run, so
the safest path is to run update.sh which is idempotent.`;

const LEGACY_RE = /^APP_URL=https?:\/\/\$\{DOMAIN\}/m;

async function envHasLegacyShape(): Promise<boolean> {
    const f = Bun.file(".env");
    if (!(await f.exists())) return false;
    const text = await f.text();
    return LEGACY_RE.test(text);
}

export const recipe: Recipe = {
    slug: "legacy_env_shape",
    describe: async () => DESCRIBE,
    detect: envHasLegacyShape,
    async fix() {
        const r = await capture($`./scripts/update.sh`);
        if (!r.ok) {
            return {
                ok: false,
                detail: r.stderr.split("\n")[0] || `update.sh exited ${r.code}`,
            };
        }
        return { ok: true };
    },
    async verify() {
        return !(await envHasLegacyShape());
    },
};
