#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only

import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { bootstrapMaterialPath, loadAdminConfig } from "@cool-tunnel/config";
import { backupAdminSqlite } from "@cool-tunnel/db";
import { composeProjectName, serviceRunning } from "./src/util/compose";
import { loadDotenv, mergeEnv } from "./src/util/env";
import { acquireOpLock, LOCK_HELD_MARKER } from "./src/util/op-lock";
import { ensureRepoRoot } from "./src/util/repo-root";
import { $, capture } from "./src/util/sh";
import { die, makeTerm } from "./src/util/term";

const { step, ok } = makeTerm();

async function snapshotVolume(volumeName: string, tmpDir: string, destName: string): Promise<void> {
  const wasRunning = await serviceRunning("caddy");
  if (wasRunning) await capture($`docker compose stop caddy`);
  let result: Awaited<ReturnType<typeof capture>>;
  try {
    const cwd = process.cwd();
    result = await capture(
      $`docker run --pull never --rm --entrypoint sh -v ${`${volumeName}:/data:ro`} -v ${`${cwd}/${tmpDir}:/out`} cool-tunnel-server-caddy:latest -c ${`cd /data && tar czf /out/${destName} .`}`,
    );
  } finally {
    if (wasRunning) await capture($`docker compose start caddy`);
  }
  if (!result.ok) die(`tar of ${volumeName} failed`, result.stderr.split("\n")[0] ?? "");
}

export async function runBackup(): Promise<number> {
  process.umask(0o077);
  ensureRepoRoot(import.meta.url);
  if (!Bun.which("docker"))
    die("required command 'docker' is not on PATH", "Install Docker and retry.");
  if (!process.env[LOCK_HELD_MARKER]) await acquireOpLock();

  const dotenv = await loadDotenv([".env"]);
  const config = loadAdminConfig(
    mergeEnv(process.env as Record<string, string>, dotenv?.env ?? null),
  );
  const ts = new Date()
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/:/g, "-");
  const out = `backups/cool-tunnel-${ts}.tar.gz`;
  mkdirSync("backups", { recursive: true });
  mkdirSync("tmp", { recursive: true });
  const tmpDir = mkdtempSync("tmp/backup-");

  try {
    step("Snapshot admin SQLite database");
    backupAdminSqlite(config.dbPath, `${tmpDir}/admin.sqlite`);
    ok("admin.sqlite written");

    step("Snapshot Caddy ACME state");
    const project = await composeProjectName();
    await snapshotVolume(`${project}_caddy_data`, tmpDir, "caddy_data.tgz");
    ok("caddy_data.tgz written");

    step(`Bundle into ${out}`);
    const material = bootstrapMaterialPath(config);
    // The repo-root files must be added with an absolute `-C`, not
    // `-C ..`. `tmpDir` is two levels deep (`tmp/backup-XXXXXX`), so a
    // relative `-C ..` lands in `tmp/`, not the repo root, and tar
    // fails with "package.json: Cannot stat: No such file or directory".
    // `ensureRepoRoot()` above guarantees cwd is the repo root here.
    const repoRoot = process.cwd();
    const tar = await capture(
      $`tar -czf ${out} -C ${tmpDir} admin.sqlite caddy_data.tgz -C ${repoRoot} .env manifests caddy/Caddyfile.tpl package.json pnpm-lock.yaml`,
    );
    if (!tar.ok) die(`tar bundle failed (exit ${tar.code})`, tar.stderr.split("\n")[0] ?? "");
    chmodSync(out, 0o600);
    ok(`wrote ${out} (mode 0600)`);
    if (await Bun.file(material).exists()) {
      ok(`bootstrap material remains root-only at ${material}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await runBackup());
}
