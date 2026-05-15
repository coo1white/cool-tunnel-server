// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/credential_drift.ts — pure-TS port of
// scripts/fix.sh recipe 14.
//
// Detect: `ct-server-core guard credential-lock` exits non-zero,
// meaning at least one of db / rendered / manifest / mac-config has
// drifted. Fix: delegate to scripts/auto_sync.sh, which re-renders
// sing-box config from current DB state, restarts sing-box, and
// re-verifies the guard.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `The credential-lock guard reports NG: at least one of the four
surfaces (db / rendered / manifest / mac-config) has drifted
away from the others.

Fix: delegates to auto_sync.sh — re-render sing-box config
from current DB state, restart sing-box, re-verify the guard.`;

async function guardPasses(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await capture(
        $`docker compose exec -T panel ct-server-core guard credential-lock`,
    );
    return r.ok;
}

async function detectDrift(): Promise<boolean> {
    return !(await guardPasses());
}

export const recipe: Recipe = {
    slug: "credential_drift",
    describe: async () => DESCRIBE,
    detect: detectDrift,
    async fix() {
        const r = await capture($`./scripts/auto_sync.sh`);
        if (!r.ok) {
            return {
                ok: false,
                detail: r.stderr.split("\n")[0] || `auto_sync.sh exited ${r.code}`,
            };
        }
        return { ok: true };
    },
    async verify() {
        return await guardPasses();
    },
};
