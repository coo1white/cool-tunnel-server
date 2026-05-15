// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/pending_migrations.ts — pure-TS port of
// scripts/fix.sh recipe 12.
//
// Detect: panel is running AND `php artisan migrate:status` shows
// at least one row with "Ran? = No". Fix: `php artisan migrate --force`.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `The database schema is older than the code currently running.

This usually happens when you restore a backup that was taken on a
prior release and the DB now lacks tables / columns the new code
expects. Symptoms range from blank dashboard widgets to PHP errors
on every form submit ("Unknown column 'X' in field list").

Fix: run pending migrations forward. Laravel's \`migrate --force\`
is idempotent — already-applied migrations are skipped and the new
ones layer on cleanly. Data in existing tables is preserved.

This recipe does NOT touch table data; it only applies schema
changes from panel/database/migrations/*.php that haven't run yet.`;

async function panelRunning(): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await capture($`docker compose ps --status running panel`);
    return r.ok && /ct-panel/.test(r.stdout);
}

async function detectPending(): Promise<boolean> {
    if (!(await panelRunning())) return false;
    const r = await capture($`docker compose exec -T panel php artisan migrate:status`);
    if (!r.ok) return false;
    // Laravel migrate:status formats rows as table cells. A pending row
    // has "No" in the second column: `| <name> | No |`.
    return /^\s*\|\s*No\s*\|/m.test(r.stdout);
}

export const recipe: Recipe = {
    slug: "pending_migrations",
    describe: async () => DESCRIBE,
    detect: detectPending,
    async fix() {
        const r = await capture($`docker compose exec -T panel php artisan migrate --force`);
        if (!r.ok) {
            return {
                ok: false,
                detail: r.stderr.split("\n")[0] || `artisan migrate failed (exit ${r.code})`,
            };
        }
        await new Promise((res) => setTimeout(res, 2000));
        return { ok: true };
    },
    async verify() {
        return !(await detectPending());
    },
};
