// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/diag/collectors/proctree.ts — process tree filtered to our services.

import type { ProcTreeSnapshot } from "../types";
import { $, capture } from "../../util/sh";

const FILTER = /panel|sing-box|caddy|haproxy|redis|ct-server-core|frankenphp|octane/i;

export async function collectProcTree(): Promise<ProcTreeSnapshot> {
    // Linux ps supports `f` for forest mode; BSD/macOS ps does not.
    const linux = await capture($`ps axf -o pid,ppid,user,cmd`);
    if (linux.ok) {
        const lines = linux.stdout.split("\n").filter((l) => FILTER.test(l));
        return { lines };
    }
    const bsd = await capture($`ps aux`);
    if (!bsd.ok) return { lines: [] };
    const lines = bsd.stdout.split("\n").filter((l) => FILTER.test(l));
    return { lines };
}
