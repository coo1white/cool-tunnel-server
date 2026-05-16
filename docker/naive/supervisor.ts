// SPDX-License-Identifier: AGPL-3.0-only
//
// ct-naive container supervisor (v0.3.0+).
//
// Watches two inputs, respawns the naive child on any change:
//
//   1. /data/config/naive.json — credentials + listen port. Panel
//      writes this atomically when an admin changes a proxy account.
//      Shape:
//        {
//          "schema": 1,
//          "domain":  "naive.coolwhite.space",
//          "listen_port": 443,
//          "user":     "...",
//          "password": "...",
//          "acme_directory_dir": "acme-v02.api.letsencrypt.org-directory"
//        }
//
//   2. /data/caddy/certificates/<dir>/<domain>/<domain>.{crt,key} —
//      Caddy renews the cert every ~60 days; mtime change triggers
//      the same respawn path. Read-only mount from caddy_data.
//
// Why a custom supervisor and not a Docker `restart: unless-stopped`
// loop with the naive process as PID 1: we'd need a docker exec or
// docker-socket path to trigger the restart from outside the
// container, which both widens the attack surface and pulls in a
// docker CLI dependency the runtime image doesn't otherwise need.
// A file-watch supervisor inside the container is the simpler
// contract: panel writes, supervisor reacts. No privileged
// orchestration plane required.
//
// Why Bun: matches the project's "more bun" direction in
// operator/* and bin/ct. The watcher logic is ~150 LoC of TS — a
// shell script with inotifywait would work but composes worse with
// the JSON parsing, HTTP healthz endpoint, and graceful shutdown.

import { spawn, type Subprocess } from "bun";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const CONFIG_PATH = "/data/config/naive.json";
// CERT_ROOT carries an extra `caddy/` segment vs. ct-caddy's view of the
// same volume. Inside ct-caddy the volume is mounted at /data, and Caddy
// writes its storage to /data/caddy/certificates/... (Caddy's default
// XDG_DATA_HOME-relative path). Inside ct-naive the SAME volume is
// mounted at /data/caddy (so /data/config can also be a separate mount
// without a read-only-mount collision), which makes the volume root
// land at /data/caddy and the actual cert path
// /data/caddy/caddy/certificates/. The double `caddy/` is the
// alignment cost of keeping the two mount points distinct. v0.3.0
// expected `/data/caddy/certificates/` and silently failed every
// findCertPair on the 2026-05-16 first-deploy.
const CERT_ROOT = "/data/caddy/caddy/certificates";
const RUNTIME_DIR = "/tmp/naive-runtime";
const RUNTIME_CONFIG = join(RUNTIME_DIR, "naive.config.json");
const HEALTHZ_PORT = 9091;

// Debounce window. fs.watch fires multiple times per atomic-write
// (rename + chmod + truncate); coalesce events inside this window
// so we don't respawn naive three times for one credential update.
const DEBOUNCE_MS = 250;

type NaiveCtConfig = {
  schema: 1;
  domain: string;
  listen_port: number;
  user: string;
  password: string;
  acme_directory_dir: string;
};

type State = {
  child: Subprocess | null;
  configMtime: number;
  certMtime: number;
};

const state: State = {
  child: null,
  configMtime: 0,
  certMtime: 0,
};

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) {
  // One JSON line per event. Matches the json-file driver's
  // expectations and stays grep-friendly.
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

function loadConfig(): NaiveCtConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`config missing: ${CONFIG_PATH}`);
  }
  // Sync read keeps the restart path linear — Bun.file().text() is
  // async and would force every event handler to be async-await,
  // muddying the debounce timeline.
  const text = readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(text) as NaiveCtConfig;
  if (parsed.schema !== 1) {
    throw new Error(`unsupported config schema: ${parsed.schema}`);
  }
  // A bare user/password is acceptable (the renderer writes empty
  // strings when no active account exists; supervisor will sit at
  // waiting_for_config rather than crash). Validate type, not
  // non-emptiness.
  for (const f of ["domain", "user", "password", "acme_directory_dir"] as const) {
    if (typeof parsed[f] !== "string") {
      throw new Error(`config field has wrong type: ${f}`);
    }
  }
  if (
    !Number.isInteger(parsed.listen_port) ||
    parsed.listen_port < 1 ||
    parsed.listen_port > 65535
  ) {
    throw new Error(`invalid listen_port: ${parsed.listen_port}`);
  }
  if (parsed.user === "" || parsed.password === "" || parsed.domain === "") {
    throw new Error("config has empty user/password/domain — supervisor waits for next render");
  }
  return parsed;
}

function findCertPair(cfg: NaiveCtConfig): { cert: string; key: string } | null {
  // Caddy stores ACME-issued certs at:
  //   /data/caddy/certificates/<acme_directory_dir>/<domain>/<domain>.{crt,key}
  // where <acme_directory_dir> is a slugified ACME directory URL
  // (e.g. "acme-v02.api.letsencrypt.org-directory" for Let's Encrypt
  // production). We trust the panel-provided slug rather than
  // guessing — the panel knows which directory Caddy was configured
  // against via the same ServerConfig row.
  const dir = join(CERT_ROOT, cfg.acme_directory_dir, cfg.domain);
  const cert = join(dir, `${cfg.domain}.crt`);
  const key = join(dir, `${cfg.domain}.key`);
  if (existsSync(cert) && existsSync(key)) {
    return { cert, key };
  }
  // Defence: fall back to scanning if the panel-supplied slug
  // doesn't match the actual on-disk directory (Caddy version
  // change, ACME directory rotation). Pick whichever directory
  // contains a matching cert pair.
  if (!existsSync(CERT_ROOT)) return null;
  for (const subdir of readdirSync(CERT_ROOT)) {
    const cand = join(CERT_ROOT, subdir, cfg.domain);
    const c = join(cand, `${cfg.domain}.crt`);
    const k = join(cand, `${cfg.domain}.key`);
    if (existsSync(c) && existsSync(k)) {
      log("warn", "cert_pair_found_via_scan", { expected: cert, found_under: subdir });
      return { cert: c, key: k };
    }
  }
  return null;
}

function writeRuntimeConfig(cfg: NaiveCtConfig, pair: { cert: string; key: string }) {
  // naive accepts a JSON config via `--config=path`. The schema is
  // documented at klzgrad/naiveproxy README — flat object, dashed
  // keys equivalent to the long CLI flags. We only set what we need.
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const payload = {
    listen: `https://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@0.0.0.0:${cfg.listen_port}`,
    cert: pair.cert,
    key: pair.key,
    log: "",
  };
  writeFileSync(RUNTIME_CONFIG, JSON.stringify(payload), { mode: 0o600 });
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

async function killChild(child: Subprocess, label: string) {
  log("info", "killing_naive", { label, pid: child.pid });
  child.kill("SIGTERM");
  // Wait up to 5s for graceful exit; SIGKILL otherwise. Naive
  // closes listeners on SIGTERM and exits within ~100ms in normal
  // operation; the ceiling exists to catch a wedged child.
  const exited = await Promise.race([
    child.exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
  ]);
  if (!exited) {
    log("warn", "naive_did_not_exit_killing", { pid: child.pid });
    child.kill("SIGKILL");
    await child.exited;
  }
}

async function spawnNaive(cfg: NaiveCtConfig, pair: { cert: string; key: string }) {
  writeRuntimeConfig(cfg, pair);
  log("info", "spawning_naive", {
    listen_port: cfg.listen_port,
    cert_mtime: new Date(safeMtime(pair.cert)).toISOString(),
  });
  const child = spawn({
    cmd: ["/usr/local/bin/naive", `--config=${RUNTIME_CONFIG}`],
    stdout: "inherit",
    stderr: "inherit",
    onExit(_proc, exitCode, signal) {
      log(exitCode === 0 ? "info" : "warn", "naive_exited", {
        exit_code: exitCode,
        signal,
      });
    },
  });
  state.child = child;
  state.configMtime = safeMtime(CONFIG_PATH);
  state.certMtime = safeMtime(pair.cert);
}

let restartPending: ReturnType<typeof setTimeout> | null = null;

async function scheduleRestart(reason: string) {
  if (restartPending) clearTimeout(restartPending);
  restartPending = setTimeout(async () => {
    restartPending = null;
    log("info", "restart_triggered", { reason });
    try {
      const cfg = loadConfig();
      const pair = findCertPair(cfg);
      if (!pair) {
        log("error", "cert_pair_missing", { domain: cfg.domain });
        // Keep current child alive; better to serve with stale
        // cert than no cert. Will retry on next event.
        return;
      }
      if (state.child) {
        await killChild(state.child, reason);
        state.child = null;
      }
      await spawnNaive(cfg, pair);
    } catch (err) {
      log("error", "restart_failed", { reason, error: String(err) });
    }
  }, DEBOUNCE_MS);
}

function startWatchers(cfg: NaiveCtConfig) {
  // Watch the config file itself.
  watch(CONFIG_PATH, () => scheduleRestart("config_changed"));
  // Watch the cert directory recursively for renewal events. Caddy
  // writes via atomic rename, so the parent directory sees a new
  // mtime even when individual cert files keep theirs (in practice
  // mtimes change too; we watch both for belt-and-braces).
  const certDir = join(CERT_ROOT, cfg.acme_directory_dir, cfg.domain);
  if (existsSync(certDir)) {
    watch(certDir, () => scheduleRestart("cert_changed"));
  } else {
    log("warn", "cert_dir_absent_at_boot", { certDir });
  }
}

function startHealthz() {
  Bun.serve({
    hostname: "127.0.0.1",
    port: HEALTHZ_PORT,
    fetch(req) {
      if (new URL(req.url).pathname !== "/healthz") {
        return new Response("not found", { status: 404 });
      }
      const naivePid = state.child?.pid ?? null;
      const naiveAlive = state.child != null && !state.child.killed;
      return Response.json(
        {
          status: naiveAlive ? "ok" : "starting",
          naive_pid: naivePid,
          config_mtime: state.configMtime,
          cert_mtime: state.certMtime,
        },
        { status: naiveAlive ? 200 : 503 },
      );
    },
  });
  log("info", "healthz_listening", { port: HEALTHZ_PORT });
}

async function main() {
  log("info", "supervisor_starting");

  // Wait up to 60s for the panel to write the initial config and
  // for Caddy to acquire the initial cert. The container should
  // come up before either has happened on a cold deploy.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const cfg = loadConfig();
      const pair = findCertPair(cfg);
      if (pair) {
        await spawnNaive(cfg, pair);
        startWatchers(cfg);
        startHealthz();
        // SIGTERM from docker stop → kill child + exit cleanly.
        process.on("SIGTERM", async () => {
          log("info", "sigterm_received");
          if (state.child) await killChild(state.child, "sigterm");
          process.exit(0);
        });
        process.on("SIGINT", async () => {
          log("info", "sigint_received");
          if (state.child) await killChild(state.child, "sigint");
          process.exit(0);
        });
        return;
      }
      log("info", "waiting_for_cert", { domain: cfg.domain });
    } catch (err) {
      log("info", "waiting_for_config", { error: String(err) });
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log("error", "boot_timeout", {
    detail: "config or cert never materialised within 60s",
  });
  // Still expose healthz so docker can detect the wedge and restart
  // the container; let the supervisor exit otherwise to surface
  // the failure in `docker compose ps`.
  startHealthz();
  process.exit(1);
}

await main();
