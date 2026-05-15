#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/verify-sot.ts — pure-TS port of scripts/verify_sot.sh +
// scripts/verify_sot_vps.sh.
//
// Cycle 3 / v0.0.55 cross-language SoT validator. Both
// implementations of `panel_domain` (PHP in panel/, Rust in core/)
// must agree byte-for-byte for every (PANEL_DOMAIN, DOMAIN) pair in
// the fixture matrix.
//
// Two modes:
//   --mode=host   PHP and cargo invoked directly on the host
//                 (dev-side `make verify-sot`, part of `make ci`)
//   --mode=vps    docker compose exec into the running panel
//                 container (operator-side `make verify-sot-vps`)
//
// Graceful skip semantics from the bash originals preserved:
//   - host mode skips with exit 0 + "missing tools" message when
//     the host lacks php/cargo (most VPSes; dev hosts are fine).
//   - vps mode exits 1 with a "bring the stack up first" message
//     when the panel container is not reachable.

import { $ } from "bun";
import { FIXTURES, formatOutcome, runFixtures } from "./src/util/sot";
import { makeHostRunner, makeVpsRunner } from "./src/util/sot-runners";
import { ensureRepoRoot } from "./src/util/repo-root";

type Mode = "host" | "vps";
export type ParseResult = { ok: true; mode: Mode } | { ok: false; error: string };

export function parseMode(argv: readonly string[]): ParseResult {
    let mode: Mode | null = null;
    for (const a of argv) {
        if (a === "--mode=host") mode = "host";
        else if (a === "--mode=vps") mode = "vps";
        else if (a.startsWith("--mode=")) {
            return { ok: false, error: `verify-sot: unknown mode "${a.slice("--mode=".length)}"` };
        }
    }
    if (!mode) return { ok: false, error: "verify-sot: --mode=host or --mode=vps required" };
    return { ok: true, mode };
}

async function preflightHost(): Promise<string | null> {
    const missing: string[] = [];
    if (!Bun.which("php")) missing.push("php");
    if (!Bun.which("cargo")) missing.push("cargo");
    if (missing.length === 0) return null;
    return `=== Cycle 3 / v0.0.55 — Panel-hostname SoT cross-language verification ===
  ⚠ skipped — host missing: ${missing.join(" ")}

This script invokes PHP and cargo directly on the host to
compare the two SoT implementations. Docker-only VPS hosts
typically don't have the dev toolchains installed.

For VPS confirmation, use the docker-based variant:

    make verify-sot-vps

It runs the same ${FIXTURES.length} fixtures via \`docker compose exec\`
against the running panel container, so it needs no host
toolchains. (v0.0.56.)`;
}

async function preflightVps(): Promise<string | null> {
    if (!Bun.which("docker")) {
        return "verify-sot-vps: docker not on PATH";
    }
    const r = await $`docker compose exec -T panel true`.nothrow().quiet();
    if (r.exitCode === 0) return null;
    return `=== verify-sot-vps — Cycle 3 SoT cross-language verification (VPS) ===
  ✗ panel container is not running (or \`docker compose exec\` failed)

Bring the stack up first:

    docker compose up -d

then re-run:

    make verify-sot-vps`;
}

async function main(): Promise<number> {
    const parsed = parseMode(process.argv);
    if (!parsed.ok) {
        console.error(parsed.error);
        return 2;
    }
    const mode = parsed.mode;

    ensureRepoRoot(import.meta.url);

    let runner;
    let banner: string;
    if (mode === "host") {
        const skip = await preflightHost();
        if (skip) {
            console.log(skip);
            return 0; // host-mode skip is exit 0 — keeps `make ci` green
        }
        runner = makeHostRunner();
        banner = "=== Cycle 3 / v0.0.55 — Panel-hostname SoT cross-language verification ===";
    } else {
        const skip = await preflightVps();
        if (skip) {
            console.error(skip);
            return 1; // vps-mode preflight failure is a hard error
        }
        runner = makeVpsRunner();
        banner = "=== verify-sot-vps — Cycle 3 SoT cross-language verification (VPS) ===";
    }

    console.log(banner);
    const summary = await runFixtures(runner);
    for (const outcome of summary.outcomes) console.log(formatOutcome(outcome));
    console.log("");
    console.log(`=== summary: ${summary.passed} passed, ${summary.failed} failed ===`);
    return summary.failed === 0 ? 0 : 1;
}

if (import.meta.main) {
    const code = await main();
    process.exit(code);
}
