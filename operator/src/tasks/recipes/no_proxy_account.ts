// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/no_proxy_account.ts — pure-TS port of
// ct fix recipe 15.
//
// Detect: panel running AND zero enabled rows in proxy_accounts.
// Fix: there is no automated fix — this recipe is informational. It
// prints the canonical create-an-account instructions and returns
// ok:true so the walker continues. verify() will still report failure
// (the issue persists until the operator acts), which is intentional:
// it surfaces in the summary as a reminder.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `No active proxy account exists in the database. Without one:
  - End-users have no subscription URL to import into their
    Mac client.

Fix: this recipe does NOT auto-create an account (because the
operator needs to choose a username + may want a memorable
password). Instead it prints the canonical recipe for creating
one. Run it manually:

  Option A (recommended — via Filament UI, no password echoed):
    1. Log into https://panel.<DOMAIN>/admin
    2. Proxy Accounts → New Proxy Account
    3. Enter username, click "Generate" for password, Create

  Option B (CLI, password echoes once — scrub bash history after):
    docker compose exec -T panel php artisan tinker --execute='
        $pw = bin2hex(random_bytes(16));
        $a = new \\App\\Models\\ProxyAccount();
        $a->username = "user1";
        $a->setCleartextPassword($pw);
        $a->enabled = true;
        $a->save();
        echo "user=user1 pw=" . $pw . PHP_EOL;
    '`;

async function panelRunning(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await capture($`docker compose ps --status running panel`);
    return r.ok && r.stdout.includes("ct-panel");
}

async function activeAccountCount(): Promise<number | null> {
    // Single-quoted PHP source. \App\Models\ProxyAccount only needs
    // one backslash per segment when passed straight as argv (Bun.$
    // doesn't go through a shell, so PHP receives exactly this text).
    const php = 'echo \\App\\Models\\ProxyAccount::where("enabled", true)->count();';
    const r = await capture($`docker compose exec -T panel php artisan tinker --execute=${php}`);
    if (!r.ok) return null;
    // tinker may print a banner before the count; take the last
    // non-empty token that parses as an int.
    const tokens = r.stdout.trim().split(/\s+/).filter(Boolean);
    for (let i = tokens.length - 1; i >= 0; i--) {
        const n = parseInt(tokens[i]!, 10);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

async function detectNone(): Promise<boolean> {
    if (!(await panelRunning())) return false;
    const count = await activeAccountCount();
    return count === 0;
}

export const recipe: Recipe = {
    slug: "no_proxy_account",
    describe: async () => DESCRIBE,
    detect: detectNone,
    async fix() {
        process.stderr.write(
            "      note: skip-fix recipe — prints instructions; nothing to apply\n",
        );
        return { ok: true };
    },
    async verify() {
        // The recipe is informational: nothing was applied, so the
        // detected condition persists. Report verified=false so the
        // walker counts it as un-cleared (matches the bash recipe's
        // behaviour, which surfaces it in the summary).
        return !(await detectNone());
    },
};
