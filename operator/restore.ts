#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only

import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { posix as pathPosix } from "node:path";
import { $, capture, runStreaming } from "./src/util/sh";
import { composeProjectName } from "./src/util/compose";
import { die, makeTerm } from "./src/util/term";
import { acquireOpLock, LOCK_HELD_MARKER } from "./src/util/op-lock";
import { ensureRepoRoot } from "./src/util/repo-root";

const { step, ok } = makeTerm();

export function parseRestoreArgs(argv: readonly string[]): { path: string } | string {
    const cmdIdx = argv.indexOf("restore");
    const rest = (cmdIdx >= 0 ? argv.slice(cmdIdx + 1) : argv.slice(2)).filter((a) => a !== "--json");
    if (rest.length === 0) return "restore: usage: restore <backup.tar.gz>";
    if (rest.length > 1) return "restore: takes exactly one argument (the backup tarball path)";
    return { path: rest[0]! };
}

export function validateTarEntries(entries: readonly string[]): string | null {
    for (const raw of entries) {
        const entry = raw.trim();
        if (entry === "") continue;
        if (entry.startsWith("/") || entry.startsWith("\\")) return `backup archive contains absolute path: ${entry}`;
        if (/^[A-Za-z]:[\\/]/.test(entry)) return `backup archive contains drive-qualified path: ${entry}`;
        const normalized = pathPosix.normalize(entry.replace(/\\/g, "/"));
        if (normalized === ".." || normalized.startsWith("../")) return `backup archive escapes restore directory: ${entry}`;
    }
    return null;
}

export function expectedRestoreVolumes(project: string): string[] {
    return [`${project}_caddy_data`, `${project}_caddy_etc`, `${project}_singbox_config`];
}

export function staleVolumeNames(existing: readonly string[], project: string): string[] {
    const expected = new Set(expectedRestoreVolumes(project));
    return existing.filter((name) => expected.has(name)).sort();
}

async function validateTarballMembers(path: string): Promise<void> {
    const listed = await capture($`tar -tzf ${path}`);
    if (!listed.ok) die(`tar -tzf ${path} failed`, listed.stderr.split("\n")[0] ?? "");
    const err = validateTarEntries(listed.stdout.split("\n"));
    if (err) die(err, "refusing to restore an unsafe backup archive");
}

function requireRestoredPath(path: string, label: string): void {
    if (!existsSync(path)) die(`backup is missing required ${label}`, `expected ${path} after extraction`);
}

async function stackIsRunning(): Promise<boolean> {
    const r = await capture($`docker compose ps -q`);
    return r.ok && r.stdout.trim().length > 0;
}

async function composeVolumeNames(): Promise<string[]> {
    const r = await capture($`docker volume ls --format ${"{{.Name}}"}`);
    return r.ok ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

export async function runRestore(backupPath: string): Promise<number> {
    process.umask(0o077);
    ensureRepoRoot(import.meta.url);
    if (!(await Bun.file(backupPath).exists())) die(`required file '${backupPath}' is missing`, "did you mean a file under backups/?");
    if (!Bun.which("docker")) die("required command 'docker' is not on PATH", "Install Docker and retry.");
    if (!process.env[LOCK_HELD_MARKER]) await acquireOpLock();
    if (await stackIsRunning()) die("stack is currently running; refusing to restore over it", "docker compose down -v");

    const project = await composeProjectName();
    const stale = staleVolumeNames(await composeVolumeNames(), project);
    if (stale.length > 0) die("existing Docker volumes would be mixed with backup data", `remove old stack first: docker compose down -v\nstale volumes: ${stale.join(", ")}`);

    step("Stage backup tarball");
    mkdirSync("tmp", { recursive: true });
    const restoreDir = mkdtempSync("tmp/restore-");
    try {
        await validateTarballMembers(backupPath);
        const extract = await capture($`tar -xzf ${backupPath} -C ${restoreDir}`);
        if (!extract.ok) die(`tar -xzf ${backupPath} failed`, extract.stderr.split("\n")[0] ?? "");

        step("Restore files");
        requireRestoredPath(`${restoreDir}/.env`, ".env");
        requireRestoredPath(`${restoreDir}/admin.sqlite`, "admin.sqlite");
        requireRestoredPath(`${restoreDir}/caddy_data.tgz`, "caddy_data.tgz");
        requireRestoredPath(`${restoreDir}/manifests`, "manifests/");
        cpSync(`${restoreDir}/.env`, ".env");
        chmodSync(".env", 0o600);
        rmSync("manifests", { recursive: true, force: true });
        cpSync(`${restoreDir}/manifests`, "manifests", { recursive: true });
        if (existsSync(`${restoreDir}/caddy/Caddyfile.tpl`)) cpSync(`${restoreDir}/caddy/Caddyfile.tpl`, "caddy/Caddyfile.tpl");
        ok(".env, manifests, and template restored");

        step("Load prebuilt Docker image bundle");
        const bundle = await runStreaming($`./scripts/fetch_image_bundle.sh`);
        if (!bundle.ok) die("prebuilt Docker image bundle is required", "run ./scripts/fetch_image_bundle.sh, then retry restore");

        step("Restore admin SQLite");
        mkdirSync("data/admin", { recursive: true, mode: 0o700 });
        copyFileSync(`${restoreDir}/admin.sqlite`, "data/admin/admin.sqlite");
        chmodSync("data/admin/admin.sqlite", 0o600);
        ok("data/admin/admin.sqlite restored");

        step("Restore volumes");
        const cwd = process.cwd();
        const caddyVolume = `${project}_caddy_data`;
        await capture($`docker volume create ${caddyVolume}`);
        const caddyCopy = await capture(
            $`docker run --pull never --rm --entrypoint sh -v ${`${caddyVolume}:/data`} -v ${`${cwd}/${restoreDir}:/in:ro`} cool-tunnel-server-caddy:latest -c ${"cd /data && tar xzf /in/caddy_data.tgz"}`,
        );
        if (!caddyCopy.ok) die("Caddy state restore failed", caddyCopy.stderr.split("\n")[0] ?? "");
        ok("caddy_data restored");

        step("Start v0.5.2 stack");
        const up = await capture($`docker compose up -d --no-build --pull never --remove-orphans admin-api admin-web singbox caddy`);
        if (!up.ok) die("compose up failed", up.stderr.split("\n").slice(0, 5).join("\n"));
        ok("restore complete; run ./ct doctor");
    } finally {
        rmSync(restoreDir, { recursive: true, force: true });
    }
    return 0;
}

if (import.meta.main) {
    const parsed = parseRestoreArgs(process.argv);
    if (typeof parsed === "string") {
        process.stderr.write(parsed + "\n");
        process.exit(2);
    }
    process.exit(await runRestore(parsed.path));
}
