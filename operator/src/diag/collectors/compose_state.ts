// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/diag/collectors/compose_state.ts — snapshot of every
// docker compose service's runtime state at incident time.
//
// Why this exists (dogfood lesson): for the v0.1.3 haproxy-SIGHUP
// incident, the deciding piece of evidence was that haproxy had
// EXITED — not crash-looped, not unhealthy, just gone. The
// proctree collector misses an absent process (negative space)
// and the journal collector shows the last-100 docker logs, but
// no single field tells the reader "haproxy: Exited (137) about
// 30s ago" the way docker compose ps does. This collector
// captures that view. (HAProxy is gone from the stack since
// v0.2.0; the dogfood scenario stands as the design rationale
// even though the exact service name has changed.)

import type { ComposeState, ComposeService } from "../types";
import { $, capture, which } from "../../util/sh";

export async function collectComposeState(): Promise<ComposeState> {
    if (!(await which("docker"))) {
        return { services: [], note: "docker not on PATH" };
    }
    const r = await capture($`docker compose ps --all --format json`);
    if (!r.ok) {
        return { services: [], note: `docker compose ps failed (exit ${r.code})` };
    }
    const services: ComposeService[] = [];
    for (const line of r.stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            const row = JSON.parse(t) as Record<string, unknown>;
            services.push({
                service: String(row["Service"] ?? "?"),
                name: String(row["Name"] ?? "?"),
                state: String(row["State"] ?? "unknown"),
                status: String(row["Status"] ?? ""),
                health: row["Health"] ? String(row["Health"]) : undefined,
                exit_code: typeof row["ExitCode"] === "number" ? row["ExitCode"] : undefined,
            });
        } catch {
            // Skip non-JSON lines (older compose versions, error messages).
        }
    }
    return { services };
}
