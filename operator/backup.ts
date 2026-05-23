#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/backup.ts — `ct backup` implementation.
//
// Snapshot the deployment's state into a single timestamped tarball
// under ./backups/. Contents:
//   - db.sql                 mariadb-dump (consistent, single-tx)
//   - caddy_data.tgz         caddy ACME state (cert + private keys)
//   - .env                   secrets + tenant config
//   - manifests/             release manifest set
//
// File mode is 0600 (operator-only) per the round-9 DR audit; the
// tarball contains both APP_KEY and the encrypted password blobs —
// world-readable mode is a confidentiality bug.
//
// Single-flight: re-execs itself under `flock -n` so two concurrent
// backups (or a concurrent install / update / restore) can't race.
// Per-project lock means parallel deployments on the same host
// (e.g. /opt/ct-prod and /opt/ct-staging) don't serialise against
// each other — matches scripts/lib.sh::acquire_op_lock.

import { mkdirSync, rmSync, chmodSync, mkdtempSync } from "node:fs";
import { $, capture } from "./src/util/sh";
import { loadDotenv } from "./src/util/env";
import { composeProjectName, serviceRunning } from "./src/util/compose";
import { die, makeTerm } from "./src/util/term";
import { acquireOpLock, LOCK_HELD_MARKER } from "./src/util/op-lock";
import { ensureRepoRoot } from "./src/util/repo-root";

const { step, ok } = makeTerm();

async function dumpDatabase(env: Record<string, string>, dest: string): Promise<void> {
    const dbPw = env["DB_ROOT_PASSWORD"] ?? "";
    const dbName = env["DB_DATABASE"] ?? "cooltunnel";
    step("Dump MariaDB (consistent snapshot)");
    // Pass the password via MYSQL_PWD env so it never lands in argv
    // (visible in `ps -ef`). mariadb-dump auto-reads it when no -p
    // is given. v0.0.17 supply-chain hygiene.
    const r = await capture(
        $`docker compose exec -T -e MYSQL_PWD=${dbPw} db mariadb-dump --single-transaction --quick --routines --triggers -u root ${dbName} > ${dest}`,
    );
    if (!r.ok) {
        die(
            `mariadb-dump failed (exit ${r.code})`,
            r.stderr.split("\n").slice(0, 3).join(" / ") || "check db container status",
        );
    }
    ok("db.sql written");
}

async function snapshotCaddyData(volumeName: string, tmpDir: string, destName: string): Promise<void> {
    step("Snapshot caddy_data volume (ACME certificates + private keys)");
    // Quiesce caddy first — a cert renewal completing mid-tar would
    // land a half-written *.crt or *.key in the archive.
    const wasRunning = await serviceRunning("caddy");
    if (wasRunning) {
        await capture($`docker compose stop caddy`);
    }
    let r;
    try {
        const cwd = process.cwd();
        r = await capture(
            $`docker run --pull never --rm --entrypoint sh -v ${`${volumeName}:/data:ro`} -v ${`${cwd}/${tmpDir}:/out`} cool-tunnel-server-caddy:latest -c ${`cd /data && tar czf /out/${destName} .`}`,
        );
    } finally {
        if (wasRunning) {
            await capture($`docker compose start caddy`);
        }
    }
    if (!r.ok) {
        die(`tar of caddy_data volume failed (exit ${r.code})`, r.stderr.split("\n")[0] ?? "");
    }
    ok(`caddy_data.tgz written (from volume ${volumeName})`);
}

async function bundleTarball(outPath: string, tmpDir: string): Promise<void> {
    step(`Bundle into ${outPath}`);
    const r = await capture(
        $`tar -czf ${outPath} -C ${tmpDir} db.sql caddy_data.tgz -C .. .env manifests caddy/Caddyfile.tpl`,
    );
    if (!r.ok) {
        die(`tar bundle failed (exit ${r.code})`, r.stderr.split("\n")[0] ?? "");
    }
    chmodSync(outPath, 0o600);
}

// Exported entrypoint so the standalone CLI here and the
// operator/src/tasks/backup.ts wrapper share one implementation.
export async function runBackup(): Promise<number> {
    // Round-9 DR audit fix: the tarball contains .env (APP_KEY,
    // DB_ROOT_PASSWORD, REDIS_PASSWORD) AND the encrypted password
    // blobs. World-readable would let any other user on the host
    // recover all tenant cleartext. Mode 0600 on the tarball + the
    // intermediate tmp/* files.
    process.umask(0o077);

    // Resolve cwd to repo root so relative paths (.env, manifests,
    // caddy/) resolve correctly when invoked from anywhere.
    // `ensureRepoRoot` is /$bunfs-safe; see its
    // docstring for the dev-vs-compiled-binary detection.
    ensureRepoRoot(import.meta.url);

    // Pre-flight checks. Bash original calls require_file / require_docker
    // before locking; we do the same.
    const envExists = await Bun.file(".env").exists();
    if (!envExists) {
        die("required file '.env' is missing", `cp .env.example .env  &&  $EDITOR .env`);
    }
    if (!Bun.which("docker")) {
        die("required command 'docker' is not on PATH", "Install per docs/installation-debian.md");
    }

    // Single-flight lock via flock re-exec. Skip when already in
    // the locked child.
    if (!process.env[LOCK_HELD_MARKER]) {
        await acquireOpLock();
    }

    const loaded = await loadDotenv([".env"]);
    const env = loaded?.env ?? {};

    const ts = new Date()
        .toISOString()
        .replace(/\.\d+Z$/, "Z")
        .replace(/:/g, "-");
    const out = `backups/cool-tunnel-${ts}.tar.gz`;
    mkdirSync("backups", { recursive: true });
    mkdirSync("tmp", { recursive: true });
    const tmpDir = mkdtempSync("tmp/backup-");

    try {
        await dumpDatabase(env, `${tmpDir}/db.sql`);

        const project = await composeProjectName();
        const caddyDataVolume = `${project}_caddy_data`;
        await snapshotCaddyData(caddyDataVolume, tmpDir, "caddy_data.tgz");

        await bundleTarball(out, tmpDir);

        const ls = await capture($`ls -lh ${out}`);
        const sizeAndPath = ls.ok
            ? ls.stdout.split(/\s+/).slice(4, 6).join(" ").trim()
            : out;
        ok(`wrote ${sizeAndPath} (mode 0600 — operator-only)`);
    } finally {
        try {
            rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // best effort
        }
    }
    return 0;
}

if (import.meta.main) {
    const code = await runBackup();
    process.exit(code);
}
