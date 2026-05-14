// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/diag/collectors/journal.ts — last 100 lines per service from
// systemd journal or docker compose logs, whichever is available.

import type { JournalSlice } from "../types";
import { $, capture, which } from "../../util/sh";

const DEFAULT_UNITS = ["panel", "sing-box", "caddy", "haproxy", "redis"];
const TAIL = 100;

export async function collectJournal(
    units: string[] = DEFAULT_UNITS,
): Promise<Record<string, JournalSlice>> {
    const out: Record<string, JournalSlice> = {};
    const haveJournalctl = await which("journalctl");
    const haveDocker = await which("docker");

    for (const u of units) {
        let lines: string[] = [];
        let source = "none";

        if (haveJournalctl) {
            const r = await capture($`journalctl -u ${u} --no-pager -n ${TAIL}`);
            if (r.ok && r.stdout.trim()) {
                lines = r.stdout.trim().split("\n");
                source = "journalctl";
            }
        }
        if (lines.length === 0 && haveDocker) {
            const r = await capture($`docker compose logs --no-color --tail=${TAIL} ${u}`);
            if (r.ok && r.stdout.trim()) {
                lines = r.stdout.trim().split("\n");
                source = "docker-compose";
            }
        }

        out[u] = {
            unit: `${u} (${source})`,
            lines,
            truncated: lines.length >= TAIL,
        };
    }
    return out;
}
