#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only

import { $, capture, runStreaming } from "./src/util/sh";
import { die, makeTerm } from "./src/util/term";
import { dieWithDiag } from "./src/util/diag";
import { acquireOpLock, LOCK_HELD_MARKER } from "./src/util/op-lock";
import { checkDiskSpace, checkNetwork } from "./src/util/preflight";
import { ensureRepoRoot } from "./src/util/repo-root";
import { loadAdminConfig } from "@cool-tunnel/config";
import { AdminStore, migrateAdminDb, openAdminDb } from "@cool-tunnel/db";
import { loadDotenv, mergeEnv } from "./src/util/env";

const { step, ok, warn } = makeTerm();

async function failOnPreflight(): Promise<void> {
    const network = await checkNetwork();
    if (!network.ok) dieWithDiag(network.failure.summary, network.failure.diag);
    const disk = await checkDiskSpace();
    if (!disk.ok) dieWithDiag(disk.failure.summary, disk.failure.diag);
}

async function prepareImageBundle(): Promise<void> {
    step("Load prebuilt Docker image bundle");
    const bundle = await runStreaming($`./scripts/fetch_image_bundle.sh`);
    if (!bundle.ok) {
        dieWithDiag(
            "prebuilt Docker image bundle is required",
            `This VPS install path does not compile Docker images locally.

Recovery:
  ./scripts/fetch_image_bundle.sh
  ./ct install`,
        );
    }
    ok("prebuilt Docker image bundle loaded");
}

async function migrateSqlite(): Promise<void> {
    step("Migrate admin SQLite database");
    const dotenv = await loadDotenv([".env"]);
    const config = loadAdminConfig(mergeEnv(process.env as Record<string, string>, dotenv?.env ?? null));
    const { db } = openAdminDb(config.dbPath);
    try {
        migrateAdminDb(db);
        const store = new AdminStore(db, config);
        store.ensureDefaults(config);
        ok(`SQLite schema current at ${config.dbPath}`);
        if (!store.hasOwner()) warn("no owner exists yet; run `ct admin bootstrap` after services start");
    } finally {
        db.close();
    }
}

async function renderInitialConfig(): Promise<void> {
    step("Render Caddyfile and sing-box config");
    const caddy = await capture($`docker compose run --rm --no-deps admin-api bun -e ${renderScript("render-caddyfile")}`);
    if (!caddy.ok) die("Caddyfile render failed", caddy.stderr.split("\n")[0] ?? "");
    const singbox = await capture($`docker compose run --rm --no-deps admin-api bun -e ${renderScript("render-singbox")}`);
    if (!singbox.ok) die("sing-box render failed", singbox.stderr.split("\n")[0] ?? "");
    ok("runtime configs rendered");
}

async function startStack(): Promise<void> {
    step("Start Cool Tunnel stack");
    const up = await capture($`docker compose up -d --no-build --pull never --remove-orphans admin-api admin-web singbox caddy`);
    if (!up.ok) die("compose up failed", up.stderr.split("\n").slice(0, 5).join("\n"));
    ok("admin-api, admin-web, singbox, and caddy started");
}

export function renderScript(action: "render-caddyfile" | "render-singbox"): string {
    return `
      import { loadAdminConfig } from "./packages/config/src/index.ts";
      import { AdminStore, migrateAdminDb, openAdminDb } from "./packages/db/src/index.ts";
      import { runCoreAction } from "./apps/api/src/core-boundary.ts";
      const config = loadAdminConfig(process.env);
      const { db } = openAdminDb(config.dbPath);
      migrateAdminDb(db);
      const store = new AdminStore(db, config);
      store.ensureDefaults(config);
      const result = await runCoreAction(${JSON.stringify(action)}, config, store);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      db.close();
      process.exit(result.ok ? 0 : (result.code || 1));
    `;
}

export async function runInstall(): Promise<number> {
    process.umask(0o077);
    ensureRepoRoot(import.meta.url);
    if (!process.env[LOCK_HELD_MARKER]) await acquireOpLock();
    if (!(await Bun.file(".env").exists())) die("required file '.env' is missing", "cp .env.example .env && $EDITOR .env");
    if (!Bun.which("docker")) die("required command 'docker' is not on PATH", "Install Docker and retry.");

    await failOnPreflight();
    await prepareImageBundle();
    await migrateSqlite();
    await renderInitialConfig();
    await startStack();

    step("Next");
    ok("run `ct doctor`");
    ok("run `ct admin bootstrap` if this is the first owner setup");
    return 0;
}

if (import.meta.main) {
    process.exit(await runInstall());
}
