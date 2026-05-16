// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/src/util/atomic-write.ts — temp-then-rename atomic writes.

import { mkdirSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Write `body` to `path` atomically — write to a sibling temp file with
 * O_EXCL semantics, then rename. The rename(2) on POSIX is atomic for
 * within-filesystem moves, so a concurrent reader sees either the old
 * content or the new content, never a partial write.
 *
 * Mode 0o644 by default — readable by every process on the container,
 * which is necessary because the supervisor and the sing-box child may
 * run as different uids.
 */
export function atomicWrite(path: string, body: string, mode: number = 0o644): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const suffix = randomBytes(4).toString("hex");
    const tmp = join(dir, `.singbox-core.tmp.${suffix}`);
    writeFileSync(tmp, body, { mode });
    // chmod again in case the umask stripped bits during create.
    chmodSync(tmp, mode);
    renameSync(tmp, path);
}
