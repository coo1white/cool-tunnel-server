#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/build.ts — bun build --compile wrapper.
//
// Usage:
//   bun run build.ts                 # default target (linux-x64)
//   bun run build.ts linux-arm64
//   bun run build.ts all             # build every target in the matrix
//
// Bakes BUILD_VERSION (from package.json) into the compiled binary.

import { $ } from "bun";

const TARGETS = {
    "linux-x64": "bun-linux-x64-modern",
    "linux-arm64": "bun-linux-arm64",
    "darwin-arm64": "bun-darwin-arm64",
} as const;

type Target = keyof typeof TARGETS;

function isTarget(s: string): s is Target {
    return Object.prototype.hasOwnProperty.call(TARGETS, s);
}

const arg = process.argv[2];
let selected: Target[];
if (!arg) {
    selected = ["linux-x64"];
} else if (arg === "all") {
    selected = Object.keys(TARGETS) as Target[];
} else if (isTarget(arg)) {
    selected = [arg];
} else {
    console.error(`unknown target: ${arg}\navailable: ${Object.keys(TARGETS).join(", ")}, all`);
    process.exit(2);
}

const pkg = (await Bun.file("./package.json").json()) as { version: string };
const version = pkg.version;

for (const t of selected) {
    const outName = `bin/ct-operator-${t}`;
    console.error(`building ${outName} (target=${TARGETS[t]}, version=${version})`);
    await $`bun build ./src/index.ts \
        --compile \
        --target=${TARGETS[t]} \
        --outfile=${outName} \
        --define BUILD_VERSION=${JSON.stringify(version)} \
        --minify`;
    console.error(`built ${outName}`);
}
