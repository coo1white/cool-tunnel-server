// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/credential_drift.ts — pure-TS port of
// scripts/fix.sh recipe 14.
//
// Detect: `ct-server-core guard credential-lock` exits non-zero,
// meaning at least one of db / rendered / manifest / mac-config has
// drifted. Fix: run the credential-sync audit + correct cycle
// in-process (same logic the standalone `ct-operator auto-sync`
// task uses).

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";
import { runCredentialSync } from "../../util/credential-sync";

const DESCRIBE = `The credential-lock guard reports NG: at least one of the four
surfaces (db / rendered / manifest / mac-config) has drifted
away from the others.

Fix: run the credential-sync cycle — re-render sing-box config
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
        const r = await runCredentialSync({
            logger: {
                // The fix walker already prints its own framing
                // ("[fix] credential_drift") and operators don't
                // need the timestamped auto-sync log lines here —
                // route them to stderr where they're available if
                // the operator wants to look but don't clutter the
                // walker's stdout.
                info: (line) => process.stderr.write(line + "\n"),
                err: (line) => process.stderr.write(line + "\n"),
                raw: (text) => process.stderr.write(text + "\n"),
            },
        });
        if (r.ok) return { ok: true };
        return { ok: false, detail: r.detail ?? r.outcome };
    },
    async verify() {
        return await guardPasses();
    },
};
