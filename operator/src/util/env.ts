// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/env.ts — .env loader.
//
// Best-effort parser for KEY=VALUE lines with optional surrounding quotes
// and #-comments. Does NOT shell-source (no variable expansion, no command
// substitution) — Cool Tunnel Server's .env.example uses only simple
// literals so this is sufficient.

import { stat } from "node:fs/promises";

export type EnvMap = Record<string, string>;

export interface DotenvLoad {
    path: string;
    env: EnvMap;
}

export async function loadDotenv(searchPaths: string[]): Promise<DotenvLoad | null> {
    for (const p of searchPaths) {
        try {
            const s = await stat(p);
            if (!s.isFile()) continue;
        } catch {
            continue;
        }
        const text = await Bun.file(p).text();
        return { path: p, env: parseDotenv(text) };
    }
    return null;
}

export function parseDotenv(text: string): EnvMap {
    const env: EnvMap = {};
    for (const rawLine of text.split("\n")) {
        const line = rawLine.replace(/^\s+|\s+$/g, "");
        if (line === "" || line.startsWith("#")) continue;
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m || !m[1]) continue;
        const key = m[1];
        let val = m[2] ?? "";
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        } else {
            val = val.replace(/\s+#.*$/, "").trimEnd();
        }
        env[key] = val;
    }
    return env;
}

// Merge process.env with a loaded .env. process.env wins.
export function mergeEnv(base: EnvMap, overlay: EnvMap | null): EnvMap {
    const out: EnvMap = { ...(overlay ?? {}) };
    for (const [k, v] of Object.entries(base)) {
        if (v !== undefined) out[k] = v;
    }
    return out;
}
