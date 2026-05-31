#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only

import { accessSync, constants as fsConstants } from "node:fs";
import { acquireOpLock } from "./src/util/op-lock";
import { probeVersions, readCurrentVersion, upgradeAvailable } from "./src/util/release";
import { ensureRepoRoot } from "./src/util/repo-root";
import { $, capture } from "./src/util/sh";

const AUTO_UPDATE_MARKER = "CT_AUTOUPDATE_FLOCK_HELD";

export interface AutoUpdateOptions {
  readonly quiet: boolean;
  readonly dryRun: boolean;
}

export function parseAutoUpdateArgs(argv: readonly string[]): AutoUpdateOptions | string {
  let quiet = false;
  let dryRun = false;
  const cmdIdx = argv.indexOf("auto-update");
  const rest = cmdIdx >= 0 ? argv.slice(cmdIdx + 1) : argv.slice(2);
  for (const arg of rest) {
    if (arg === "--quiet" || arg === "-q") quiet = true;
    else if (arg === "--dry-run" || arg === "-n") dryRun = true;
    else if (arg === "--json") continue;
    else return `auto-update: unknown flag: ${arg}`;
  }
  return { quiet, dryRun };
}

function stamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function pickLockPath(): string {
  try {
    accessSync("/var/lock", fsConstants.W_OK);
    return "/var/lock/cool-tunnel-auto-update.lock";
  } catch {
    return "/tmp/cool-tunnel-auto-update.lock";
  }
}

function makeLog(quiet: boolean): { say(message: string): void; err(message: string): void } {
  return {
    say: (message) => {
      if (!quiet) process.stdout.write(`[${stamp()}] auto-update: ${message}\n`);
    },
    err: (message) => process.stderr.write(`[${stamp()}] auto-update: ${message}\n`),
  };
}

async function preflightStackHealthy(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const ps = await capture($`docker compose ps --status running --services`);
  if (!ps.ok) {
    return { ok: false, reason: "docker compose ps failed; run `ct doctor` before auto-updating" };
  }
  const running = new Set(
    ps.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missing = ["admin-api", "admin-web", "caddy", "singbox", "docker-proxy"].filter(
    (service) => !running.has(service),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `stack pre-flight: required services not running: ${missing.join(", ")}; run 'ct doctor' first`,
    };
  }

  const up = await capture(
    $`docker compose exec -T admin-api bun -e ${"const r=await fetch('http://127.0.0.1:9000/up'); process.exit(r.ok ? 0 : 1)"}`,
  );
  if (!up.ok) {
    return {
      ok: false,
      reason: "stack pre-flight: admin API /up is not healthy; run 'ct doctor' first",
    };
  }
  return { ok: true };
}

export async function runAutoUpdate(opts: AutoUpdateOptions): Promise<number> {
  ensureRepoRoot(import.meta.url);
  if (!process.env[AUTO_UPDATE_MARKER]) {
    await acquireOpLock({
      lockPath: pickLockPath(),
      markerName: AUTO_UPDATE_MARKER,
      busyMessage: "another auto-update is already running; skipping this tick",
      softSkip: true,
    });
  }

  process.env.CT_NO_FIX_HINT = "1";
  const log = makeLog(opts.quiet);
  const versions = await probeVersions();
  if (!versions) {
    log.err("cannot read latest tag or current version; skipping this tick");
    return 2;
  }
  const latestVersion = versions.latest.replace(/^v/, "");
  if (!upgradeAvailable(versions)) {
    log.say(`up to date (deployed=${versions.current}, latest=${versions.latest})`);
    return 0;
  }
  log.say(`upgrade available: ${versions.current} -> ${latestVersion} (tag ${versions.latest})`);
  if (opts.dryRun) {
    log.say("(dry-run) would now run git pull --ff-only and ./ct update");
    return 0;
  }

  const preflight = await preflightStackHealthy();
  if (!preflight.ok) {
    log.err(preflight.reason);
    return 2;
  }

  const pull = await capture($`git pull --ff-only origin main`);
  if (!pull.ok) {
    log.err("git pull --ff-only failed; working tree may have local changes");
    return 1;
  }
  const update = opts.quiet ? await capture($`./ct update`.quiet()) : await capture($`./ct update`);
  if (!update.ok) {
    log.err("./ct update failed; re-run interactively, then run ct doctor");
    return 1;
  }
  const newVersion = (await readCurrentVersion()) ?? "?";
  log.say(`upgraded: ${versions.current} -> ${newVersion}`);
  return 0;
}

if (import.meta.main) {
  const parsed = parseAutoUpdateArgs(process.argv);
  if (typeof parsed === "string") {
    process.stderr.write(`${parsed}\n`);
    process.exit(2);
  }
  process.exit(await runAutoUpdate(parsed));
}
