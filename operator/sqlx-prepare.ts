#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// operator/sqlx-prepare.ts — regenerate core/.sqlx/ from the live schema.
//
// Regenerate core/.sqlx/ query metadata from the live schema. Run
// after a panel migration, a Rust sqlx::query!()/query_as!() edit,
// or on first checkout if core/.sqlx/ is missing.
//
// Sequence:
//   1. Pre-flight: docker on PATH, .env present.
//   2. Pick host (cargo + sqlx-cli) vs container (sqlx-prepare
//      compose service) mode.
//   3. Bring up `db` service; wait for MariaDB healthy.
//   4. Bring up `panel`; wait for vendor/autoload.php; run
//      `php artisan migrate --force`.
//   5. Run `cargo sqlx prepare --workspace` either on the host
//      (DATABASE_URL points at the published port) or inside the
//      sqlx-prepare compose service.
//   6. Report whether core/.sqlx/ changed (tracked diff +
//      untracked files).

import { $, capture, which } from "./src/util/sh";
import { loadDotenv } from "./src/util/env";
import { die, makeTerm } from "./src/util/term";
import { waitFor } from "./src/util/wait";
import { ensureRepoRoot } from "./src/util/repo-root";

const term = makeTerm();
const { step, ok, warn } = term;

async function dbHealthy(): Promise<boolean> {
    const r = await capture($`docker inspect -f ${"{{.State.Health.Status}}"} ct-db`);
    return r.ok && r.stdout.trim() === "healthy";
}

async function panelAutoloaderReady(): Promise<boolean> {
    const r = await capture(
        $`docker compose exec -T panel test -f /var/www/html/vendor/autoload.php`,
    );
    return r.ok;
}

// Probe whether 127.0.0.1:3306 is reachable from the host. The
// bash original uses bash's /dev/tcp magic; here we do an explicit
// TCP connect via Bun.connect. Falls back to false on any error.
async function dbPublishedOnHost(): Promise<boolean> {
    try {
        const socket = await Bun.connect({
            hostname: "127.0.0.1",
            port: 3306,
            socket: { data() {}, open() {}, close() {}, error() {}, drain() {} },
        });
        socket.end();
        return true;
    } catch {
        return false;
    }
}

async function runHostPrepare(env: Record<string, string>): Promise<void> {
    step("cargo sqlx prepare (host)");
    const dbUser = env["DB_USERNAME"] ?? "";
    const dbPw = env["DB_PASSWORD"] ?? "";
    const dbName = env["DB_DATABASE"] ?? "";
    const databaseUrl = `mysql://${dbUser}:${dbPw}@127.0.0.1:3306/${dbName}`;
    const r = await capture(
        $`cargo sqlx prepare --workspace --manifest-path core/Cargo.toml`.env({
            ...process.env,
            DATABASE_URL: databaseUrl,
        }),
    );
    if (!r.ok) {
        die(
            "cargo sqlx prepare failed",
            r.stderr.split("\n").slice(0, 3).join(" / ") || "check DATABASE_URL + db reachability",
        );
    }
}

async function runContainerPrepare(): Promise<void> {
    // Build the project's own sqlx-prepare image (a stage of
    // docker/core/Dockerfile). BuildKit reuses the cached
    // rust:1.86-alpine + alpine layers from previous core-builder
    // builds, so no fresh Docker Hub pull is needed (rate-limit-
    // safe). First run takes ~3-5 min on a 1-vCPU VPS to compile
    // sqlx-cli; subsequent runs land in seconds (layer cached).
    step("Build sqlx-prepare image (cached after first run)");
    const build = await capture($`docker compose --profile sqlx build sqlx-prepare`);
    if (!build.ok) {
        die("docker compose build sqlx-prepare failed", build.stderr.split("\n")[0] ?? "");
    }
    step("cargo sqlx prepare (compose service)");
    const r = await capture(
        $`docker compose --profile sqlx run --rm sqlx-prepare prepare --workspace`,
    );
    if (!r.ok) {
        die(
            "docker compose run sqlx-prepare failed",
            r.stderr.split("\n").slice(0, 3).join(" / ") ?? "",
        );
    }
}

async function reportDiff(): Promise<void> {
    step("Result");
    const tracked = await capture($`git diff --quiet -- core/.sqlx`);
    const untrackedR = await capture(
        $`git ls-files --others --exclude-standard -- core/.sqlx`,
    );
    const untrackedCount = untrackedR.ok
        ? untrackedR.stdout.split("\n").filter((l) => l.trim()).length
        : 0;
    if (tracked.ok && untrackedCount === 0) {
        ok("core/.sqlx/ unchanged — schema and queries already in sync");
        return;
    }
    ok("core/.sqlx/ regenerated");
    if (untrackedCount > 0) {
        process.stdout.write(`    new files: ${untrackedCount}\n`);
    }
    const stat = await capture($`git diff --stat -- core/.sqlx`);
    if (stat.ok && stat.stdout) process.stdout.write(stat.stdout);
    process.stdout.write(`↳ commit the new metadata so future builds compile offline:

      git add core/.sqlx
      git commit -m "chore(sqlx): refresh offline metadata"
      git push origin main
`);
}

async function main(): Promise<number> {
    ensureRepoRoot(import.meta.url);

    if (!(await which("docker"))) {
        die(
            "required command 'docker' is not on PATH",
            "apt install -y docker.io docker-compose-plugin",
        );
    }
    if (!(await Bun.file(".env").exists())) {
        die("required file '.env' is missing", "cp .env.example .env  &&  $EDITOR .env");
    }

    // ---------- Pick mode ----------
    let useContainer = false;
    if (!(await which("cargo"))) {
        useContainer = true;
        ok("cargo not on host — will run prepare inside rust:1.88-alpine container");
    } else if (!(await which("cargo-sqlx"))) {
        step("Install sqlx-cli (0.8.x, mysql + rustls)");
        const inst = await capture(
            $`cargo install sqlx-cli --version ${"~0.8"} --no-default-features --features ${"rustls,mysql"} --locked`,
        );
        if (!inst.ok) {
            die("cargo install sqlx-cli failed", inst.stderr.split("\n")[0] ?? "");
        }
        ok("sqlx-cli present");
    } else {
        ok("cargo + sqlx-cli on host");
    }

    // ---------- Bring DB up ----------
    const loaded = await loadDotenv([".env"]);
    const env = loaded?.env ?? {};

    step("Bring up MariaDB (db service)");
    {
        const r = await capture($`docker compose up -d db`);
        if (!r.ok) die("compose up -d db failed", r.stderr.split("\n")[0] ?? "");
    }
    ok("db container starting");

    if (!(await waitFor({ label: "MariaDB healthcheck", maxAttempts: 30, intervalMs: 2000, probe: dbHealthy }))) {
        die("MariaDB never reached healthy state", "docker compose logs --tail=80 db");
    }

    // ---------- Bring panel up + migrate ----------
    step("Bring up panel + run Laravel migrations");
    {
        const r = await capture($`docker compose up -d panel`);
        if (!r.ok) die("compose up -d panel failed", r.stderr.split("\n")[0] ?? "");
    }
    if (
        !(await waitFor({
            label: "panel vendor/autoload.php",
            maxAttempts: 12,
            intervalMs: 5000,
            probe: panelAutoloaderReady,
        }))
    ) {
        die(
            "panel container didn't lay out vendor/ within 60s",
            "docker compose logs --tail=80 panel",
        );
    }
    {
        const r = await capture(
            $`docker compose exec -T panel php artisan migrate --force --no-interaction`,
        );
        if (!r.ok) die("php artisan migrate failed", r.stderr.split("\n")[0] ?? "");
    }
    ok("schema is current");

    // ---------- Run sqlx prepare ----------
    if (useContainer) {
        await runContainerPrepare();
    } else if (await dbPublishedOnHost()) {
        await runHostPrepare(env);
    } else {
        warn("MariaDB not reachable at 127.0.0.1:3306 from host");
        warn("(no port mapping) — falling through to containerised prepare");
        await runContainerPrepare();
    }

    // ---------- Diff report ----------
    await reportDiff();
    return 0;
}

if (import.meta.main) {
    const code = await main();
    process.exit(code);
}
