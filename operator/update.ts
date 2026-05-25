#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only

import { $, capture, runStreaming } from "./src/util/sh";
import { die, makeTerm } from "./src/util/term";
import { dieWithDiag } from "./src/util/diag";
import { acquireOpLock, LOCK_HELD_MARKER } from "./src/util/op-lock";
import { checkDiskSpace, checkNetwork, checkStackUp } from "./src/util/preflight";
import { ensureRepoRoot } from "./src/util/repo-root";
import { renderScript } from "./install";
import { loadAdminConfig } from "@cool-tunnel/config";
import { AdminStore, migrateAdminDb, openAdminDb } from "@cool-tunnel/db";
import { loadDotenv, mergeEnv } from "./src/util/env";

const { step, ok, warn } = makeTerm();

async function preflight(): Promise<void> {
    const network = await checkNetwork();
    if (!network.ok) dieWithDiag(network.failure.summary, network.failure.diag);
    const disk = await checkDiskSpace();
    if (!disk.ok) dieWithDiag(disk.failure.summary, disk.failure.diag);
    const stack = await checkStackUp(["admin-api", "admin-web", "caddy", "singbox"]);
    if (!stack.ok) warn("stack is down; update will continue as install-style reconciliation");
}

async function gitPullFfOnly(): Promise<void> {
    step("Fetch release source");
    const pull = await capture($`git pull --ff-only`);
    if (!pull.ok) {
        warn("git pull --ff-only failed; continuing with local checkout");
        process.stderr.write(pull.stderr.split("\n").slice(0, 4).join("\n") + "\n");
        return;
    }
    if (pull.stdout) process.stdout.write(pull.stdout);
}

async function migrateAndReport(): Promise<void> {
    step("Migrate admin SQLite database");
    const dotenv = await loadDotenv([".env"]);
    const config = loadAdminConfig(mergeEnv(process.env as Record<string, string>, dotenv?.env ?? null));
    const { db } = openAdminDb(config.dbPath);
    try {
        migrateAdminDb(db);
        const store = new AdminStore(db, config);
        store.ensureDefaults(config);
        const status = store.migrationStatus();
        ok(status.message);
    } finally {
        db.close();
    }
}

async function reloadRuntime(): Promise<void> {
    step("Render runtime configs");
    for (const action of ["render-caddyfile", "render-singbox"] as const) {
        const rendered = await capture($`docker compose run --rm --no-deps admin-api bun -e ${renderScript(action)}`);
        if (!rendered.ok) die(`${action} failed`, rendered.stderr.split("\n")[0] ?? "");
    }
    ok("configs rendered");

    step("Recreate services");
    const up = await capture($`docker compose up -d --no-build --pull never --remove-orphans admin-api admin-web singbox caddy`);
    if (!up.ok) die("compose up failed", up.stderr.split("\n").slice(0, 5).join("\n"));
    const reload = await capture($`docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`);
    if (!reload.ok) warn("Caddy reload failed after recreate; container restart may already have loaded config");
    ok("services reconciled");
}

export async function runUpdate(): Promise<number> {
    process.umask(0o077);
    ensureRepoRoot(import.meta.url);
    if (!process.env[LOCK_HELD_MARKER]) await acquireOpLock();
    if (!(await Bun.file(".env").exists())) die("required file '.env' is missing", "cp .env.example .env && $EDITOR .env");
    if (!Bun.which("docker")) die("required command 'docker' is not on PATH", "Install Docker and retry.");

    await preflight();
    await gitPullFfOnly();

    step("Prepare prebuilt Docker image bundle");
    const bundle = await runStreaming($`./scripts/fetch_image_bundle.sh`);
    if (!bundle.ok) {
        dieWithDiag(
            "prebuilt Docker image bundle is required",
            `This VPS install/update path does not compile Docker images locally.

Recovery:
  ./scripts/fetch_image_bundle.sh
  ./ct update`,
        );
    }
    ok("prebuilt Docker image bundle loaded");

    await migrateAndReport();
    await reloadRuntime();
    return 0;
}

if (import.meta.main) {
    process.exit(await runUpdate());
}
