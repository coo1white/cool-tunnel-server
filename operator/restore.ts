#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/restore.ts — pure-TS port of scripts/restore.sh.
//
// Bring a fresh box up from a backup.ts/backup.sh tarball.
// Companion to operator/backup.ts. Stages:
//   1. Untar into tmp/restore
//   2. Restore .env + manifests + render templates
//   3. compose up -d db redis; wait for DB healthy
//   4. mariadb import the dump
//   5. Restore caddy_data volume from caddy_data.tgz
//   6. compose up -d panel; wait for entrypoint sentinel
//   7. compose up -d caddy sing-box
//   8. Best-effort component check
//
// Refuses to run over a populated stack. Single-flight under the
// same per-project flock as backup/install/update.

import { mkdirSync, rmSync, chmodSync } from "node:fs";
import { $, capture } from "./src/util/sh";
import { loadDotenv } from "./src/util/env";
import { composeProjectName } from "./src/util/compose";
import { die, makeTerm } from "./src/util/term";
import { acquireOpLock, LOCK_HELD_MARKER } from "./src/util/op-lock";
import { waitFor } from "./src/util/wait";

const { step, ok, warn } = makeTerm();

// Parse the single positional argument (path to the backup
// tarball). Skip operator-global flags. Exported for tests.
export function parseRestoreArgs(argv: readonly string[]): { path: string } | string {
    const cmdIdx = argv.indexOf("restore");
    const rest = (cmdIdx >= 0 ? argv.slice(cmdIdx + 1) : argv.slice(2)).filter(
        (a) => a !== "--json" && a !== "--no-bridge",
    );
    if (rest.length === 0) {
        return "restore: usage: restore <backup.tar.gz>";
    }
    if (rest.length > 1) {
        return "restore: takes exactly one argument (the backup tarball path)";
    }
    return { path: rest[0]! };
}

async function stackIsRunning(): Promise<boolean> {
    const r = await capture($`docker compose ps -q`);
    return r.ok && r.stdout.trim().length > 0;
}

async function dbHealthy(): Promise<boolean> {
    const r = await capture($`docker inspect -f ${"{{.State.Health.Status}}"} ct-db`);
    return r.ok && r.stdout.trim() === "healthy";
}

async function panelEntrypointDone(): Promise<boolean> {
    const r = await capture(
        $`docker compose exec -T panel test -f /tmp/cool-tunnel/entrypoint-complete`,
    );
    return r.ok;
}

export async function runRestore(backupPath: string): Promise<number> {
    // Resolve cwd to repo root so relative paths (.env, manifests,
    // sing-box/, caddy/, haproxy/) resolve correctly.
    const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    process.chdir(repoRoot);

    // Pre-flight: require the tarball, docker, and a non-running
    // stack. Bash original calls require_file / require_docker
    // before locking; same order here.
    if (!(await Bun.file(backupPath).exists())) {
        die(`required file '${backupPath}' is missing`, "did you mean a file under backups/?");
    }
    if (!Bun.which("docker")) {
        die("required command 'docker' is not on PATH", "Install per docs/installation-debian.md");
    }

    if (!process.env[LOCK_HELD_MARKER]) {
        await acquireOpLock();
    }

    // Refuse to restore over a populated stack — too easy to nuke
    // a live deployment by typing the wrong path. Operator must
    // explicitly `docker compose down -v` first.
    if (await stackIsRunning()) {
        die(
            "stack is currently running — refusing to restore over it",
            "docker compose down -v   # ⚠️  destroys the current stack",
        );
    }

    // ---------- Stage 1 ----------
    step("Stage backup tarball under tmp/restore");
    rmSync("tmp/restore", { recursive: true, force: true });
    mkdirSync("tmp/restore", { recursive: true });
    {
        const r = await capture($`tar -xzf ${backupPath} -C tmp/restore`);
        if (!r.ok) die(`tar -xzf ${backupPath} failed`, r.stderr.split("\n")[0] ?? "");
    }
    const lsR = await capture($`ls tmp/restore`);
    if (lsR.ok) process.stdout.write(lsR.stdout.split("\n").slice(0, 10).join("\n") + "\n");

    // ---------- Stage 2 ----------
    step("Restore .env, manifests, templates");
    // .env contains the operator's DOMAIN / *_PASSWORD /
    // CT_CLASH_SECRET_SEED edits — without it sing-box won't
    // render the same config and prior subscription tokens won't
    // verify.
    await capture($`cp tmp/restore/.env .env`);
    chmodSync(".env", 0o600);
    await capture($`cp -r tmp/restore/manifests .`);
    // Templates: legacy backups (pre-round-9) may lack one or more;
    // the in-tree post-update template is the correct fallback in
    // that case, so the cp failures are non-fatal.
    await capture($`cp tmp/restore/sing-box/config.json.tpl sing-box/config.json.tpl`);
    await capture($`cp tmp/restore/caddy/Caddyfile.tpl caddy/Caddyfile.tpl`);
    await capture($`cp tmp/restore/haproxy/haproxy.cfg.tpl haproxy/haproxy.cfg.tpl`);
    ok(".env restored (mode 0600), manifests + templates in place");

    // ---------- Stage 3 ----------
    const loaded = await loadDotenv([".env"]);
    const env = loaded?.env ?? {};

    step("Bring up db + redis (NOT panel/sing-box yet)");
    {
        const r = await capture($`docker compose up -d db redis`);
        if (!r.ok) die(`compose up -d db redis failed`, r.stderr.split("\n")[0] ?? "");
    }
    const dbOk = await waitFor({
        label: "MariaDB healthcheck",
        maxAttempts: 30,
        intervalMs: 2000,
        probe: dbHealthy,
    });
    if (!dbOk) die("MariaDB never reached healthy state", "docker compose logs --tail=80 db");

    // ---------- Stage 4 ----------
    step("Import db.sql into MariaDB");
    // Password discipline: MYSQL_PWD via env, never argv. The
    // mariadb client auto-reads MYSQL_PWD when no -p is given —
    // the secret never reaches `ps -ef` inside the container or
    // any host-side process collector. v0.0.17 hygiene.
    const dbPw = env["MARIADB_ROOT_PASSWORD"] ?? "";
    const dbName = env["MARIADB_DATABASE"] ?? "cooltunnel";
    {
        const r = await capture(
            $`docker compose exec -T -e MYSQL_PWD=${dbPw} db mariadb -u root ${dbName} < tmp/restore/db.sql`,
        );
        if (!r.ok) {
            die(`db.sql import failed — see ct-db logs`, "docker compose logs --tail=50 db");
        }
    }
    ok("db.sql imported");

    // ---------- Stage 5 ----------
    step("Restore caddy_data volume from caddy_data.tgz");
    const project = await composeProjectName();
    const caddyDataVolume = `${project}_caddy_data`;
    const inspect = await capture($`docker volume inspect ${caddyDataVolume}`);
    if (!inspect.ok) {
        await capture($`docker volume create ${caddyDataVolume}`);
    }
    const cwd = process.cwd();
    {
        const r = await capture(
            $`docker run --rm -v ${`${caddyDataVolume}:/data`} -v ${`${cwd}/tmp/restore:/in:ro`} alpine sh -c ${"cd /data && tar xzf /in/caddy_data.tgz"}`,
        );
        if (!r.ok) {
            die(
                `untar of caddy_data.tgz failed (exit ${r.code})`,
                r.stderr.split("\n")[0] ?? "",
            );
        }
    }
    ok(`caddy_data restored (ACME certs + private keys, into ${caddyDataVolume})`);

    // ---------- Stage 6 ----------
    step("Bring up panel + caddy + sing-box");
    {
        const r = await capture($`docker compose up -d panel`);
        if (!r.ok) die("compose up -d panel failed", r.stderr.split("\n")[0] ?? "");
    }
    // Wait for the entrypoint-complete sentinel — same contract
    // install.sh uses (round-9 DR audit). Presence of the sentinel
    // means migrate + seed + config:cache + asset publish all
    // finished cleanly.
    const panelOk = await waitFor({
        label: "panel entrypoint sentinel",
        maxAttempts: 18, // 18 * 5s = 90s — bash original uses 90s window
        intervalMs: 5000,
        probe: panelEntrypointDone,
    });
    if (!panelOk) {
        die(
            "panel entrypoint did not finish within 90s",
            "docker compose logs --tail=120 panel",
        );
    }
    await capture($`docker compose up -d caddy sing-box`);
    await new Promise((r) => setTimeout(r, 5000));

    // ---------- Stage 7: best-effort component check ----------
    step("Component check");
    // The full component_check_strict helper from scripts/lib.sh
    // greps for NG in `ct-server-core component check`'s table
    // output. Replicate that here as a soft warning rather than a
    // hard die — the bash original `|| warn`s too.
    const cc = await capture(
        $`docker compose exec -T panel ct-server-core component check --manifests-dir /srv/manifests`,
    );
    if (!cc.ok || /\bNG\b/.test(cc.stdout)) {
        warn("some components NG — investigate before serving real users");
    } else {
        ok("all components OK");
    }

    rmSync("tmp/restore", { recursive: true, force: true });

    const panelDomain = env["PANEL_DOMAIN"] ?? "?";
    process.stdout.write(`
[1m[32mRestore complete.[0m

  Panel         https://${panelDomain}/admin    (or via SSH-local-port-forward to 127.0.0.1:9000)
  Subscription  https://${panelDomain}/api/v1/subscription/<token>

Next:
  1. Tail logs:    docker compose logs -f --tail=80
  2. Confirm proxy: ./scripts/late-night-comeback.sh
  3. Test subscription: curl one of the manifest URLs you had before

If the restored .env had a different CT_CLASH_SECRET_SEED than the
running stack expected (you ran restore mid-flight without first
\`compose down\`), bearer mismatches will show up as panel→sing-box
clash-API 401s — \`docker compose restart panel sing-box\` resolves it.
`);
    return 0;
}

async function main(): Promise<number> {
    const parsed = parseRestoreArgs(process.argv);
    if (typeof parsed === "string") {
        console.error(parsed);
        console.error("ls backups/");
        return 2;
    }
    return await runRestore(parsed.path);
}

if (import.meta.main) {
    const code = await main();
    process.exit(code);
}
