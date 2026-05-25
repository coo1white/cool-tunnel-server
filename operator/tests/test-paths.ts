// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const REPO_ROOT = existsSync("operator/package.json") ? process.cwd() : resolve(process.cwd(), "..");

export function repoPath(path: string): string {
    return resolve(REPO_ROOT, path);
}

export function operatorPath(path: string): string {
    return resolve(REPO_ROOT, "operator", path);
}
