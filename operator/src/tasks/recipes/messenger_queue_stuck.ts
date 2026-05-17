// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/tasks/recipes/messenger_queue_stuck.ts — pure-TS port of
// ct fix recipe 13.
//
// Detect: Redis stream cool_tunnel:messenger has > 100 unprocessed
// messages (steady state is ~0). Fix: restart the panel container so
// supervisord re-spawns the messenger:consume worker.

import type { Recipe } from "./types";
import { $, capture, which } from "../../util/sh";

const DESCRIBE = `The Symfony Messenger queue (Redis stream cool_tunnel:messenger)
has more than 100 unprocessed messages.

That means the background worker inside the panel container has
stopped consuming jobs — usually because it hit an exception and
supervisord did not respawn it (rare). Symptoms: revocations don't
take effect, scheduled jobs don't run, "the panel feels frozen"
on actions that fire async work.

Fix: restart the panel container. supervisord re-spawns the
messenger:consume worker on every panel boot, which clears the
stuck state. The queue drains over the next ~30 seconds as the
worker catches up.

No data loss — Redis Stream messages persist; the worker resumes
from the consumer-group offset and processes them in order.`;

const THRESHOLD = 100;

async function serviceRunning(svc: string, containerName: string): Promise<boolean> {
    if (!(await which("docker"))) return false;
    const r = await capture($`docker compose ps --status running ${svc}`);
    return r.ok && r.stdout.includes(containerName);
}

async function streamDepth(): Promise<number | null> {
    const r = await capture(
        $`docker compose exec -T redis redis-cli --no-auth-warning xlen cool_tunnel:messenger`,
    );
    if (!r.ok) return null;
    const n = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
}

async function detectStuck(): Promise<boolean> {
    if (!(await serviceRunning("panel", "ct-panel"))) return false;
    if (!(await serviceRunning("redis", "ct-redis"))) return false;
    const depth = await streamDepth();
    return depth !== null && depth > THRESHOLD;
}

export const recipe: Recipe = {
    slug: "messenger_queue_stuck",
    describe: async () => DESCRIBE,
    detect: detectStuck,
    async fix() {
        const r = await capture($`docker compose restart panel`);
        if (!r.ok) {
            return {
                ok: false,
                detail: r.stderr.split("\n")[0] || "compose restart panel failed",
            };
        }
        await new Promise((res) => setTimeout(res, 10000));
        return { ok: true };
    },
    async verify() {
        return !(await detectStuck());
    },
};
