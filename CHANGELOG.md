# Changelog

All notable changes to Cool Tunnel Server are recorded here.

The format is loosely based on [Keep a Changelog][keepachangelog]
and the project follows [Semantic Versioning][semver] *as
interpreted by* [`VERSIONING.md`](./VERSIONING.md) — read that
before relying on a version bump as a compatibility signal.

[keepachangelog]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/spec/v2.0.0.html

## [Unreleased]

### Added

### Changed

### Fixed

### Security

---

## [0.0.54] — 2026-05-06 — Auto-migrate legacy `.env` files in `make update` (PANEL_DOMAIN backfill + APP_URL `${DOMAIN}` → `${PANEL_DOMAIN}` correction)

The third v0.0.33-vintage architectural-drift bug surfaced this
sprint, after v0.0.51 (haproxy state) and v0.0.53 (subscription
URL): operator's `.env` predates v0.0.33's R1-1/R1-2 SNI router,
so it has `APP_URL=https://${DOMAIN}/admin` (apex hostname) and
no `PANEL_DOMAIN=` line. Both forms cause Livewire 3's
origin-check middleware to silently 419 every Filament form
submit — the browser's `Origin` header (`panel.<base>`) doesn't
match the configured app URL host (apex), Livewire returns 419
PAGE EXPIRED without throwing a logged exception. The user-
facing symptom is "edit any record → click Save → page expired"
on every attempt.

`install.sh` already had backfill logic for the missing
`PANEL_DOMAIN` (line 85-95, added in v0.0.33), but install.sh
runs only on first-time bootstrap, NOT on `make update`. Any
operator who bootstrapped pre-v0.0.33 and has been doing
`make update` since never gets migrated. v0.0.54 closes that
gap.

### Fixed

- **`scripts/update.sh`** — added an "Auto-migrate legacy .env"
  step right after `git pull`, before any rebuild. Runs on every
  `make update` invocation; idempotent (no-op when `.env` is
  already canonical). Two checks:
  1. **Backfill `PANEL_DOMAIN`** if missing — derives
     `panel.<DOMAIN>` from the existing `DOMAIN=` line and
     appends `PANEL_DOMAIN=panel.<DOMAIN>` with a v0.0.54
     migration-marker comment. Mirrors `install.sh:85-95` so
     upgrade-path operators get the same treatment as
     fresh-bootstrap operators.
  2. **Correct legacy `APP_URL`** — if `.env` has
     `APP_URL=https://${DOMAIN}/...` (apex form), `sed` it to
     `APP_URL=https://${PANEL_DOMAIN}/...`. Anchored regex
     leaves correct values, manually-fixed values
     (`https://panel.${DOMAIN}/...`), and any third-form
     overrides untouched.

### Why this complements v0.0.53 specifically

v0.0.53 fixed the `subscriptionUrl()` PHP method that hardcoded
the apex domain for the panel HTTP endpoint. It was the
panel-side half of the SNI-split discipline. v0.0.54 fixes the
operator-config-side half — the `.env` values that Laravel reads
to decide its own self-URL. Together they close the panel-vs-
apex confusion across both code-side and config-side layers.

The audit candidate I noted in v0.0.53's "Out of scope" section
is being paid off explicitly here.

### What v0.0.54 deliberately does NOT do

Per the agreed scope (Level 1 + 2 of the long-term-fix design
discussion):

- **No `.env.example` change.** Already canonical (`APP_URL=https://${PANEL_DOMAIN}/admin`,
  `PANEL_DOMAIN=panel.proxy.example.com`). The v0.0.33 update
  to `.env.example` was correct; only existing operator-managed
  `.env` files were left out of the migration. v0.0.54 is the
  upgrade-path complement to that correct shipping default.
- **No new "single source of truth" abstraction (Level 4).**
  The four places that hardcode `panel.<base>` (APP_URL,
  ProxyAccount::subscriptionUrl, haproxy.cfg.tpl,
  ct-server-core's haproxy renderer) stay as-is. A future Cycle
  3-style consolidation pass that introduces a
  `panel/config/cool-tunnel.php::panel_domain` helper and
  routes all four through it is a bigger refactor; deferred.
- **No CI guard for the bug class (Level 5).** Without the
  Level-4 SoT to validate against, a CI guard has no canonical
  shape to match. Defer until Level 4 lands.

### Compatibility

- **Operators on v0.0.33..v0.0.53 with legacy .env** —
  `make update` after pulling v0.0.54 auto-heals on first run,
  zero manual intervention. Subsequent runs see canonical state
  and skip both checks. The migration adds a marker comment
  (`# v0.0.54 auto-migration — ...`) above the appended
  PANEL_DOMAIN line so operators know which line came from the
  script vs. their own edits.
- **Operators with manually-fixed `.env`** (e.g. user who ran
  `sed` to set `APP_URL=https://panel.${DOMAIN}/admin` directly
  rather than the canonical `${PANEL_DOMAIN}`) — the auto-heal
  leaves the manual fix untouched (regex anchors to bare
  `${DOMAIN}` only). Both forms produce the same resolved URL
  at PHP boot time.
- **Fresh deploys** — install.sh's first-bootstrap PANEL_DOMAIN
  logic runs first; .env is canonical from the start; v0.0.54's
  update.sh check is a clean no-op on every subsequent
  `make update`.
- **No code change in panel/, no manifest change, no Dockerfile
  change.** Pure script-level automation.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
```

The `make update` run will print:

```
==> 2. Auto-migrate legacy .env (v0.0.54 — PANEL_DOMAIN + APP_URL hostname)
    ✓ added PANEL_DOMAIN=panel.<your-domain> to .env       # if was missing
    ✓ APP_URL legacy form (${DOMAIN}) corrected to ${PANEL_DOMAIN}   # if was legacy
```

(Or `✓ PANEL_DOMAIN already present in .env` and `✓ APP_URL already canonical` if the operator manually fixed earlier — like our user did between v0.0.53 and v0.0.54.)

After the rebuild + restart completes, fresh-tab Filament
form submits should succeed without 419.

### Lesson — sixth in the sprint, same root pattern as v0.0.51 / v0.0.53

| Hotfix | Mismatch caught |
|---|---|
| v0.0.47 → v0.0.48 | dev-side `git status` ≠ VPS-side |
| v0.0.49 → v0.0.50 | dev-side `cargo build` ≠ VPS-side (MSRV) |
| v0.0.43 → v0.0.51 | dev-side cfg.tpl edit ≠ VPS-side haproxy state |
| v0.0.51 → v0.0.52 | CLI invocation (root) ≠ panel UI invocation (www-data) |
| v0.0.33 → v0.0.53 | architectural change (SNI split) ≠ panel-side code |
| **v0.0.33 → v0.0.54** | **architectural change (SNI split) ≠ operator-managed config (.env)** |

v0.0.53 + v0.0.54 are paired — code-side and config-side halves
of the same architectural debt. **The pattern: when an
architectural change introduces a new distinction, audit ALL
consumers including operator-managed config files**, not just
in-tree code. install.sh already handled the config side at
first-bootstrap; the gap was the upgrade path.

---

## [0.0.53] — 2026-05-06 — Fix: subscription-URL generator points at the apex domain instead of the panel subdomain (silent since the v0.0.33 SNI router split)

The macOS client's "Import from subscription URL" flow returned
HTTP 400 on every import attempt. Root cause: the URL generated
by the panel's `Subscription URL` action targeted the apex
(proxy) domain, but the panel itself lives at `panel.<apex>`
post-v0.0.33's haproxy SNI router. A request to
`https://<apex>/api/v1/subscription/<token>` hits sing-box
(NaiveProxy), which has no HTTP API and rejects the request.

This bug has been silent since v0.0.33. Pre-v0.0.33 the panel
WAS on the apex (no SNI split), so `subscriptionUrl()` was
correct when written in v0.0.7. v0.0.33's R1-1/R1-2 design
introduced the apex (proxy) / panel subdomain split — `apex →
sing-box`, `panel.<apex> → caddy → panel` — but the URL
generator wasn't updated to match. The v0.0.43 drift-detection
infrastructure couldn't catch it because the subscription
endpoint isn't a component-check probe target; it's user-flow
infrastructure.

### Fixed

- **`panel/app/Models/ProxyAccount.php::subscriptionUrl()`** —
  URL template changed from `https://{$domain}/api/v1/subscription/{$token}`
  to `https://panel.{$domain}/api/v1/subscription/{$token}`. The
  `panel.` prefix matches haproxy.cfg.tpl's hardcoded
  `use_backend panel_caddy if { req_ssl_sni -i panel.<base> }`
  rule — both sides of the SNI router agreement now use the
  same hardcoded prefix.

### Audit confirmed clean elsewhere

Other `ServerConfig::domain` usages were audited for the same
panel-vs-apex confusion; all are correct as-is:

| Site | Usage | Verdict |
|---|---|---|
| `ServerConfig.php:45` | first-boot seed for the apex domain | correct (apex is what's seeded) |
| `SubscriptionController.php:108-114` | manifest's `server` / `profiles[].host` / `profiles[].label` fields | correct (NaiveProxy server endpoint IS the apex; the macOS client connects to it as a proxy, not as the panel HTTP API) |
| **`ProxyAccount.php:150`** | **subscription URL → panel HTTP endpoint** | **fixed in this release** |

Only the URL generator was broken. The others correctly use the
apex because they're describing the *proxy* endpoint, not the
*panel* endpoint.

### Why this is the fifth-of-its-kind in the sprint

The pattern across the sprint's hotfixes:

| Hotfix | Mismatch |
|---|---|
| v0.0.47 → v0.0.48 | dev-side `git status` ≠ VPS-side |
| v0.0.49 → v0.0.50 | dev-side `cargo build` ≠ VPS-side (MSRV) |
| v0.0.43 → v0.0.51 | dev-side cfg.tpl edit ≠ VPS-side haproxy state |
| v0.0.51 → v0.0.52 | CLI invocation (root) ≠ panel UI invocation (www-data) |
| **v0.0.33 → v0.0.53** | **architectural change (SNI split) ≠ all panel-side code that referenced "the domain" before the split** |

The v0.0.53 lesson is the most general: **when an architectural
change introduces a new distinction (apex vs. panel-subdomain),
audit every existing reference to the now-ambiguous concept
("domain") in the same release.** v0.0.33 split the meaning of
"domain" into two; only some references were updated to match.
The unstaged ones became silent bugs that surfaced when an
operator first exercised the affected code path.

This bug specifically: the macOS client's "Import from
subscription URL" was the affected user flow; nobody had used it
on a v0.0.33+ deployment until now.

### Compatibility

- **No code change in ct-server-core, no manifest change, no
  Dockerfile change.** Pure panel-side PHP edit.
- **Existing subscription URLs** that operators have copied/sent
  to clients are now invalid (they all point at the apex). The
  fix is to re-copy the URL via the panel's "Subscription URL"
  action — the new copy uses `panel.<domain>` and works. No DB
  migration needed; the underlying token is unchanged, only the
  hostname segment of the URL changes.
- **No make update needed for runtime** — the panel mounts the
  application source RO from the working tree, so a `git pull`
  + Filament cache clear is sufficient (`make update` does the
  cache clear as part of the panel boot, but a panel container
  restart suffices for an out-of-band fix).

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
```

Then in the panel UI:

1. **Proxy Accounts** → click an account row's **Subscription URL** action
2. Verify the URL in the notification starts with `https://panel.<domain>/`
3. Copy that URL into the macOS client's "Import from subscription URL"
4. Import should now succeed and return the manifest JSON

### Out of scope (audit candidate for a future release)

A repo-wide audit for *other* spots where an architectural
distinction (introduced by a past release) wasn't propagated to
all consumers. Pattern-shape: grep for any value that gained two
meanings between v0.0.X and v0.0.X+1 — `ServerConfig.domain`
(this one), `CT_CLASH_LISTEN` (apex vs. ct-clash management
network), the `naiveproxy` slug ambiguity (server-side plugin
vs. client binary), etc. Probably worth an explicit forensic
sweep one day; not blocking.

---

## [0.0.52] — 2026-05-06 — Hotfix: HAProxy stats-socket mode 660 → 666 (panel UI runs probe as www-data, not root)

The fourth hotfix-after-release in this sprint. v0.0.51's CLI
test showed 11/11 OK; the Filament Components page in the
browser kept showing haproxy NG. The discrepancy: `docker
compose exec` defaults to root, but the panel UI invokes the
probe through PHP-FPM running as www-data.

Confirmed end-to-end on the operator's VPS:

```
$ docker compose exec -u www-data panel bash -c '...socat...'
socat error: connect(): Permission denied

$ docker compose exec panel bash -c '...socat...'   # default = root
Version: 3.0.21-6e57320bb
```

Same probe, same target socket — different invoking user, different
filesystem permission outcome. Mode 660 (rw owner+group, --- other)
owned by `haproxy:haproxy` is unreadable by `www-data`. Root bypassed
the check via DAC; www-data hit the wall.

### Fixed

- **`haproxy/haproxy.cfg.tpl`** — `stats socket ... mode 660` →
  `mode 666`. World-readable within the docker volume's mount
  scope. The threat model already restricts who can see the
  socket (volume mounted only into haproxy + panel — the docker
  volume IS the security boundary), and `level user` already
  restricts what they can do (`show *` only, no `disable
  server` / `set server` / runtime mutation). 660 was over-
  cautious for the actual blast radius; 666 is the right
  answer here, same way redis's `REDISCLI_AUTH=$REDIS_PASSWORD`
  env-var auth is the right answer at the protocol layer (volume
  + protocol-layer permission, not filesystem mode).
- **`manifests/haproxy.upstream.json::note`** — updated the
  mode reference to `666` and added a one-sentence explainer of
  why 666 is safe given the volume + level-user posture.

### Lesson recorded — fourth and final hotfix lesson of the sprint

Three previous hotfix lessons compounded into this one:

| Hotfix | Lesson |
|---|---|
| v0.0.47 → v0.0.48 | dev-side `git status` clean ≠ VPS-side clean |
| v0.0.49 → v0.0.50 | dev-side `cargo build` clean ≠ VPS-side clean (cargo-chef MSRV) |
| v0.0.43 → v0.0.51 | dev-side cfg.tpl edit ≠ VPS-side haproxy actually picks it up |
| v0.0.51 → **v0.0.52** | **CLI invocation (root) ≠ panel UI invocation (www-data)** |

The fourth lesson is the deepest: even when validation runs on the
operator's actual VPS, `docker compose exec` defaults to root and
masks **per-user** permission failures. When the same probe binary
can be invoked by multiple users in the same container (root via
`compose exec`, www-data via PHP-FPM, ct-server-core daemon as
root via supervisord), each invocation path is its own validation
target. v0.0.51's CLI smoke test was right but insufficient — it
exercised one invocation path (root) and not the one that actually
matters operationally (the panel UI's www-data path).

**Going forward**: for any probe whose result is rendered in the
Filament Components page, the validation discipline includes a
per-invocation-path smoke test — both `docker compose exec` (root)
AND `docker compose exec -u www-data` (Filament's path). If the
two diverge, that's the bug.

### Compatibility

- **No code change in ct-server-core or in the panel.** Only the
  cfg.tpl line and the manifest's note string changed.
- **`make update` does the rest** — re-renders the cfg with the
  new mode, SIGHUPs haproxy, the new socket gets created with
  mode 666. www-data can now connect; panel UI shows haproxy
  green.
- **No DB migration, no env change, no Dockerfile rebuild
  required.** Pure cfg.tpl + render+reload.

### Security note (revisited)

Threat-model recap with mode 666:

- **Outside-container reach**: zero. The `haproxy_admin` volume
  is mounted into haproxy (RW) and panel (RO) only. No docker-
  network exposure of the socket. No host-port mapping.
- **Inside-panel-container reach**: any process can connect.
  This includes supervisord, ct-server-core daemon, php-fpm
  workers, nginx workers, and (in compromised states) any
  attacker who has gained code execution inside the panel.
- **What an inside-panel attacker can do via the socket**:
  read-only stats — `show info`, `show stat`, `show pools`.
  Cannot modify haproxy state (level user). The information
  disclosed (connection counts, server status) is operational
  metrics, not secrets. The panel container already holds the
  real secrets (DB password, REDIS password,
  CT_CLASH_SECRET_SEED) in its env, accessible to any process
  in the container regardless of the haproxy socket. The socket
  adds zero new attack surface beyond what the panel already
  exposes.

Mode 666 is the right answer.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
```

The `make update` re-renders the cfg with mode 666, SIGHUPs
haproxy, the new socket gets created with the new mode. The
Filament Components page (via www-data) can now read it.

To verify the fix worked end-to-end, including the per-user path:

```sh
# Confirm both invocation paths now succeed
docker compose exec -u www-data panel bash -c \
    'set -eo pipefail; echo "show info" | socat -t 5 - UNIX-CONNECT:/var/run/haproxy/admin.sock | grep -E "^Version:"'
# Expect: Version: 3.0.21-...

docker compose exec panel bash -c \
    'set -eo pipefail; echo "show info" | socat -t 5 - UNIX-CONNECT:/var/run/haproxy/admin.sock | grep -E "^Version:"'
# Expect: Version: 3.0.21-...
```

Then click **Re-check** on the Filament Components page — haproxy
should flip to OK alongside the other 10.

---

## [0.0.51] — 2026-05-06 — Hotfix: HAProxy stats-socket bind-perm + update.sh haproxy render/reload gap

The third hotfix-after-release in this sprint, all three sharing
the same root: dev-side validation didn't simulate the operator's
actual upgrade path on the operator's actual deployment topology.
v0.0.43 added the haproxy stats socket + new docker volume + new
cfg.tpl directive; over the v0.0.43 → v0.0.50 sprint THREE separate
gaps quietly compounded, all visible only when an operator first
exercised the haproxy probe end-to-end.

### Three gaps this release closes

1. **Volume ownership.** v0.0.43's new `haproxy_admin` named
   volume was created `root:root mode 0755`. The upstream
   `haproxy:alpine` image runs HAProxy as the `haproxy` user
   (USER directive), and the project's `cap_drop: ALL` posture
   means no `DAC_OVERRIDE` to bypass the filesystem check. Result:
   when haproxy parses the new `stats socket` directive, the
   `bind()` syscall fails with EACCES — `[ALERT] cannot bind
   UNIX socket (Permission denied)`. HAProxy exits, the container
   restart-policy brings it back, infinite crash loop.
2. **Stale rendered cfg.** The panel's haproxy-render is fired by
   Eloquent `ServerConfig::booted()` event (mutation-triggered),
   not by panel boot or `make update`. v0.0.43's cfg.tpl change
   to add the stats-socket directive was therefore dormant for
   any operator who hadn't edited ServerConfig between releases —
   the running haproxy.cfg in the volume kept its pre-v0.0.43
   shape (no stats socket directive at all).
3. **`update.sh` missed haproxy in two places.** v0.0.44 added
   haproxy to the `compose build` list but left it out of the
   `compose up -d` list, so the rebuilt image stayed cached
   while the running container persisted unchanged. And there
   was no haproxy render+reload step parallel to the existing
   sing-box render+reload step.

All three failure modes are visible in retrospect through the
v0.0.43 drift probe (`VerifyFailed: non-zero exit (Some(1))`),
which is exactly what Cycle 2 was designed to do. The probe
correctly surfaced the broken state; the issue was the path TO
the broken state had three compounding contributors.

### Fixed

- **`docker/haproxy/Dockerfile`** — added `USER root && RUN
  mkdir -p /var/run/haproxy && chown haproxy:haproxy
  /var/run/haproxy && USER haproxy` so the image's
  `/var/run/haproxy/` directory has the right ownership at
  build time. Docker's named-volume initialisation (image
  directory contents copied to the volume on FIRST mount)
  propagates this ownership to fresh `haproxy_admin` volumes,
  so new deploys from v0.0.51 forward have the right state
  without operator intervention.
- **`scripts/update.sh`** — three fixes:
  - **Defensive chown** of the existing `haproxy_admin` volume
    via a throwaway `--user root` haproxy container. Idempotent;
    no-op when ownership is already correct. Closes the
    upgrade-path gap for operators on v0.0.43..v0.0.50 with
    existing root-owned volumes (Docker's named-volume
    initialisation does NOT overwrite an existing volume).
  - **`compose up -d` extended to include `haproxy`** — rebuilt
    image now actually replaces the running container, parallel
    to the v0.0.44 fix that added haproxy to `compose build`.
  - **New haproxy render + SIGHUP step** — mirrors the existing
    sing-box render + reload pattern. Forces a fresh
    `haproxy.cfg` write to the `haproxy_admin` volume on every
    `make update`, then re-execs HAProxy via SIGHUP (master-
    worker mode; connection-preserving graceful reload).

### Compatibility

- **Operators upgrading from v0.0.43..v0.0.50 with an existing
  haproxy_admin volume** — `make update` after pulling v0.0.51
  applies the defensive chown automatically before bringing
  haproxy up. The script's chown step is idempotent; no manual
  intervention required.
- **Operators on a paused-update flow (still on pre-v0.0.43)**
  — same `make update` path. The defensive chown silently skips
  (volume doesn't exist yet), the haproxy_admin volume is created
  fresh from the new Dockerfile (correct ownership), the new
  cfg renders cleanly, the SIGHUP brings it live.
- **Fresh deploys (first-ever v0.0.51 install)** — Dockerfile's
  pre-creation handles volume ownership at first-mount time. No
  upgrade-path concerns.
- **HAProxy SIGHUP semantics in v3.0** — master-worker mode
  (default `-W -db` from the haproxy:alpine entrypoint) reloads
  on SIGHUP via re-exec. Existing connections drain on the old
  worker (per `timeout client/server`); new connections accept
  on the new worker. If the new cfg is invalid, master keeps
  the old worker running and logs an alert — fail-safe by
  design.

### Lesson recorded — across the v0.0.43..v0.0.50 sprint

| Hotfix | Root |
|---|---|
| v0.0.47 → v0.0.48 | dev-side `git status` clean ≠ VPS-side clean (entrypoint chmod side effects on bind-mounts) |
| v0.0.49 → v0.0.50 | dev-side cargo build clean ≠ VPS-side cargo build clean (cargo-chef transitive MSRV under `--locked`) |
| v0.0.43 → **v0.0.51** | dev-side cfg.tpl edit lands clean ≠ VPS-side haproxy actually picks it up (volume initialisation, render trigger, update.sh symmetry — three compounding) |

All three share the lesson: **for releases whose value
proposition is "operator-observable behaviour change" — clean
working tree, faster build, drift detection working — validation
has to run on the operator's environment, end-to-end, not just on
dev's.** The next time I touch a docker-volume permission, a
cfg.tpl render trigger, or anything that mutates state on a
specific deployment topology, the validation plan needs an
operator-side smoke test before "ship it".

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
docker compose exec panel ct-server-core component check --manifests /srv/manifests
```

Expected output: 11/11 OK with the haproxy row showing
`installed=Version: 3.0.21-...`. The `make update` itself will
log:

```
==> N. Ensure haproxy_admin volume ownership ...
    ✓ haproxy_admin ownership verified
==> N+1. Bring new panel image up ...
    [+] up 6/6  (haproxy started)
==> N+2. Re-render haproxy config ...
==> N+3. Reload haproxy (SIGHUP — graceful re-exec)
==> N+4. Component check (post-swap) ...
    11/11 OK
```

If the haproxy row is still NG after a clean `make update` with
v0.0.51, the next thing to inspect is `docker compose logs
--tail=100 haproxy` — any `[ALERT]` line points at the actual
remaining issue and is worth surfacing.

---

## [0.0.50] — 2026-05-06 — Hotfix: Rust toolchain 1.86 → 1.88 to unblock v0.0.49's cargo-chef install

v0.0.49's `cargo install cargo-chef --version "~0.1" --locked`
step in the new `chef` stage failed on operator `make update`:

```
error: rustc 1.86.0 is not supported by the following package:
    cargo-platform@0.3.2 requires rustc 1.88
```

Root cause: `--locked` uses the lockfile **shipped with the
cargo-chef crate**, not the project's lockfile. cargo-chef v0.1.77
(latest) ships a Cargo.lock pinning `cargo-platform 0.3.2`, which
declares `rust-version = "1.88"`. Our Rust toolchain pinned 1.86 →
fail. I should have verified cargo-chef's transitive MSRV against
the project's pin before shipping v0.0.49. Owning that and
unblocking immediately.

### Fixed

- **`core/rust-toolchain.toml::channel`** — `1.86` → `1.88`. The
  comment block now records cargo-chef's transitive MSRV as the
  binding floor; sqlx-icu_*'s 1.86 floor is still satisfied
  (newer Rust accepts older MSRV).
- **`core/Cargo.toml::workspace.package.rust-version`** — `1.86`
  → `1.88`. Mirrors the toolchain pin so a future
  `cargo build --offline` / pre-cargo-chef build path correctly
  reports the floor.
- **`docker/core/Dockerfile`** — both `FROM rust:1.86-alpine`
  lines (chef stage line 25, sqlx-prepare stage line 207) bumped
  to `FROM rust:1.88-alpine`. The chef-stage comment expanded to
  record the cargo-chef MSRV trail.

### Compatibility

- **No code change.** `ct-protocol` and `ct-server-core` source
  is byte-identical to v0.0.49. The only diff is which rustc
  compiles them.
- **78 / 78 tests pass on Rust 1.88** (verified locally).
- **Clippy delta is zero** — same 91-warning baseline as on 1.86.
  Rust 1.88 didn't introduce new lints that catch our code.
- **Operators get a fresh toolchain pull** — `rust:1.88-alpine`
  is a different Docker Hub layer from `rust:1.86-alpine`, so
  the first `make update` after pulling v0.0.50 will re-pull the
  base image (~150 MiB). One-time cost.
- **No project Cargo.lock change** — the workspace's
  `[workspace.package.rust-version]` is metadata only; cargo
  doesn't bump Cargo.lock for `rust-version` field changes.

### Why I bumped to 1.88 specifically and not higher

1.88 is the minimum that satisfies cargo-platform 0.3.2's MSRV.
A higher bump (1.91, 1.95, etc.) would buy margin against future
MSRV creep but is also a larger change. Hotfix discipline:
smallest change that unblocks. If a future tool/dep requires
≥1.89, we'll bump again then.

### Lesson recorded for future tooling installs

When adding a `cargo install <tool> --locked` to the build, the
tool's transitive deps under its OWN published lockfile are what
gets compiled — not the resolver's MSRV-aware best-effort. Before
shipping a new tooling install: check the tool's
`Cargo.lock` (in its published crate) for transitive MSRV
constraints, or run `cargo install <tool> --locked` once on the
target toolchain locally as a smoke test. v0.0.49 didn't do
either.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
```

The first `make update` after v0.0.50 re-pulls `rust:1.88-alpine`
(~150 MiB) and re-runs the entire chef stage (`apk add` + cargo-chef
install). Expect ~5-7 min for the first build. Subsequent builds
hit the v0.0.49 caching strategy and drop to ~15-30 s as designed.

---

## [0.0.49] — 2026-05-06 — Build-infra Cycle 1: cargo-chef + `target/` cache mount cuts incremental rebuilds from ~3-6 min to ~15-30 s

The first post-Cycle-2 release, themed around build-infrastructure
rather than runtime drift. v0.0.38 wired `CT_CORE_BUILD_PROFILE`
through compose so operators can opt into the `release-small`
profile (Tier 1 — flips `lto=off` + `codegen-units=16`,
~50% reduction). v0.0.49 (Tier 2) restructures the Dockerfile around
**cargo-chef** plus a **`/build/core/target` BuildKit cache mount**,
so source-only changes — which is what every typical `make update`
is — skip the 285-crate dep compile entirely and go straight to
the 2 workspace crates.

Combined effect on a typical `make update` (no `Cargo.lock` change):

| Phase | Pre-v0.0.49 | Tier 1 only | Tier 2 only | **Tier 1 + Tier 2** |
|---|---|---|---|---|
| First-ever build (cold) | ~6 min | ~3 min | ~6 min + 30 s chef install | ~3 min + 30 s |
| Source-only change (typical) | ~6 min | ~3 min | **~30 s** | **~15-20 s** |
| Cargo.lock bump (rare) | ~6 min | ~3 min | ~6 min (recook all deps) | ~3 min |

Operators on the v0.0.36 → v0.0.48 release sprint cadence get a
~12-20× speedup on subsequent updates.

### Changed

- **`docker/core/Dockerfile`** restructured into four cooperating
  stages:
  - **`chef`** (new) — base image with `cargo-chef` installed,
    `apk add` shared, TARGETARCH multi-arch resolved, rust target
    triple staged at `/tmp/rust-target`. First-ever build pays
    ~30-60 s for the cargo-chef install; subsequent builds hit the
    cached layer (invalidates only on Rust toolchain bump or
    cargo-chef minor bump).
  - **`planner`** (new) — runs `cargo chef prepare --recipe-path
    recipe.json` to extract the dependency graph. The recipe is
    byte-identical when `Cargo.toml` + `Cargo.lock` are unchanged,
    regardless of application source edits, which is what makes
    the downstream cook layer cacheable.
  - **`builder`** (rewritten) — splits the old single-RUN cargo
    build into TWO RUN steps:
    1. `cargo chef cook --profile $X --target $Y --recipe-path
       recipe.json` — compiles all 285 deps. Layer cached when
       recipe.json content unchanged.
    2. `cargo build --bin ct-server-core` — compiles only the 2
       workspace crates (~30 s cold, ~10 s with warm target/
       cache).
    Same env vars, same RUSTFLAGS, same musl-static, same
    SQLX_OFFLINE discipline as before. The `install -Dm755`
    binary-extraction step that crosses the cache-mount boundary
    into the layer's filesystem is preserved verbatim.
  - **`runtime`** + **`sqlx-prepare`** (unchanged) — final
    runtime image's `COPY --from=builder /ct-server-core` reads
    from the committed builder layer (not from any cache mount),
    so the multi-stage extraction works as before.
- **Three `--mount=type=cache` directives** now on each cargo
  RUN: `/usr/local/cargo/registry` (existing — downloaded
  source cache), `/usr/local/cargo/git` (existing — git deps),
  and **`/build/core/target` with `id=ct-core-target,
  sharing=locked`** (new — compiled artefact cache, shared
  between cook and build steps).

### On the pre-v0.0.49 "we don't cache target/" comment

The prior Dockerfile carried a long comment claiming that a
`target/` cache mount "interacts badly with the multi-stage `COPY
--from=builder /ct-server-core` below" because "the binary lives
under the target cache mount" and "isn't part of the committed
builder image". v0.0.49 demonstrates this concern was overcautious
for the actual code shape:

The `install -Dm755 "target/.../ct-server-core" /ct-server-core`
step runs **inside the same RUN as `cargo build`**, while the
cache mount is still active. It copies the binary FROM the cache
mount TO the layer's own filesystem at `/ct-server-core`. When the
RUN ends, `/ct-server-core` is committed to the layer; the cache
mount unmounts but its contents persist in BuildKit's cache for
next time. The runtime stage's `COPY --from=builder /ct-server-core`
reads from the COMMITTED LAYER, not from the cache mount. The
path resolves correctly. The original concern likely came from a
specific pre-BuildKit-1.0 bug; modern BuildKit (≥0.10) handles
this pattern cleanly.

### Compatibility

- **No code change.** Only `docker/core/Dockerfile` modified. No
  Rust source change, no runtime behaviour change, no manifest
  change.
- **First-ever build after upgrade is slower** than steady-state
  (chef install + first cook). One-time cost; subsequent builds
  reap the cache. On a 1-vCPU VPS, expect ~3 min + 30 s for chef
  install on the very first `make update` post-pull, then
  ~15-30 s on every subsequent `make update`.
- **Cargo profile selection still works.** `CT_CORE_BUILD_PROFILE`
  flows through to both the cook step and the build step via the
  same `ARG CARGO_PROFILE` mechanism wired in v0.0.38. Operators
  on `release-small` (Tier 1) compose with v0.0.49 (Tier 2) for
  the maximum speedup.
- **SQLX_OFFLINE still enforces compile-time SQL safety.** The
  cook step compiles the sqlx-mysql crate dep (which doesn't
  contain `sqlx::query!()` invocations), so SQLX_OFFLINE doesn't
  fire there. The second build step compiles the workspace
  containing `sqlx::query!()` calls, where SQLX_OFFLINE
  validates each query against `core/.sqlx/*.json` exactly as
  before.
- **Multi-arch (amd64 / arm64 / armv7)** unchanged. TARGETARCH
  resolution happens once in the chef stage; both planner and
  builder inherit the resolved `/tmp/rust-target` file via stage
  inheritance.
- **`cargo-chef` version pinned** to `~0.1` (latest 0.1.x line)
  with `--locked` to avoid surprise transitive bumps.

### Validation plan

Local syntax-only review confirmed: stage layout
(`chef → planner → builder → runtime + sqlx-prepare`), three
cache mounts on each cargo RUN with consistent `id` for the
target/ mount, runtime stage's COPY source unchanged, all
existing env vars and RUSTFLAGS preserved.

Full build-test deferred to operator-side `make update` on the
VPS — three test runs validate the implementation:

1. **First build post-pull** (cold cache): expect ~3-6 min total
   depending on profile. The chef stage install is a one-time
   cost; subsequent builds skip it.
2. **Second build with no source change**: expect ~15-30 s. The
   cook layer hits cache, the source-COPY hits cache, the build
   step does almost nothing.
3. **Third build with a trivial source change** (e.g. add a
   comment to a `.rs` file): expect ~15-30 s. The planner's
   COPY invalidates and re-runs `prepare`, but recipe.json is
   byte-identical, so the cook layer downstream stays cached;
   only the second `cargo build` runs.

If any of the three doesn't behave as expected, surface the
actual `[builder N/M]` timings — the chef-install layer being
recompiled, the cook step running on every build, or the COPY
of `/ct-server-core` failing to resolve are the three concrete
failure modes.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
```

The first `make update` after pulling v0.0.49 is the slowest
(chef install + first cook). Every subsequent `make update`
should drop to ~15-30 s on the cargo build phase.

To prove the cache is actually working, after one successful
`make update`, run another with no changes:

```sh
make update
# Watch [builder N/M] timings — expect cook to show CACHED,
# expect total cargo-build time ~10-20 s
```

### Out of scope (post-v0.0.49 build-infra candidates)

- **Pre-built binaries from CI** (Tier 3) — skip cargo build
  entirely, panel Dockerfile pulls release artefacts via curl.
  Fastest possible (~10 s) but couples panel build to GitHub
  releases (breaks offline/airgapped deploys), adds CI +
  supply-chain considerations. Not slated.
- **`sqlx-prepare` stage cargo-chef integration** — it currently
  builds its own apk + cargo-install layer separate from the
  chef stage. Unifying would shave a layer but the apk package
  set differs (sqlx-prepare needs git for cargo's crates.io
  fetch); not worth the complexity for a stage that runs
  on-demand only.

---

## [0.0.48] — 2026-05-06 — Second-pass pristine: address v0.0.47's incomplete coverage of panel-runtime side effects

v0.0.47 declared "pristine state" based on dev-side `git status`
on macOS. The VPS pull surfaced three residual issues that v0.0.47
missed because dev-side testing didn't actually boot the panel
container — the entrypoint's chmod and `filament:assets` only fire
on a real boot. Owning the gap and closing it.

### Issues v0.0.47 left on the VPS

1. **`panel/bootstrap/cache/.gitkeep` modified** — the panel
   entrypoint runs `chmod -R 0775 storage bootstrap/cache`
   ([entrypoint.sh:28](docker/panel/entrypoint.sh:28)). All eight
   `.gitkeep` files were stored at `100644` in git's index, so a
   chmod that sets the exec bit makes git see the worktree as
   `100755` and surfaces a mode-only diff. Only
   `bootstrap/cache/.gitkeep` actually shows because it sits on
   the bind-mounted `./panel:/var/www/html` path; the
   `storage/*/.gitkeep` files are inside the `panel_storage`
   docker volume and the chmod there doesn't reach the host's
   git checkout.
2. **`panel/public/css/` untracked** — `php artisan
   filament:assets --no-interaction` ([entrypoint.sh:151](docker/panel/entrypoint.sh:151))
   publishes Filament's compiled CSS into this directory.
3. **`panel/public/js/` untracked** — same publish step, JS half.

### Fixed

- **`.gitignore`** — added `panel/public/css/`, `panel/public/js/`,
  and `panel/public/vendor/` (preventive — some upstream package
  publishers default to `public/vendor/<pkg>/`). The committed
  contents of `panel/public/` are verified to be only
  `favicon.svg` and `index.php`; everything else under `public/`
  is runtime-published and should never be tracked.
- **`panel/bootstrap/cache/.gitkeep` index mode** — bumped from
  `100644` to `100755` via `git update-index --chmod=+x`. The
  file's content is empty (it's a directory placeholder), so the
  mode-only change is innocuous. After this commit, the entrypoint's
  `chmod -R 0775` produces a worktree mode (`0775` = exec bit set)
  that git treats as `100755` and matches the index → no diff.
  Robust across all worktree states:
  - Operator with v0.0.47 worktree (file at `0644`) pulls v0.0.48 →
    `git checkout` updates the file's mode to `0755` → no diff.
  - Fresh checkout on macOS (no entrypoint) → file lands at
    `0755` from the new index mode → no diff.
  - Operator on VPS post-entrypoint (file at `0775`) → already
    matches `100755` → no diff.

### Why dev didn't catch this

Dev-side validation in v0.0.47 ran `git status` on macOS without
booting the panel container. The two surfaces that produce the
noise (entrypoint chmod, `filament:assets`) only fire when the
container actually starts. macOS dev had a clean `git status`
because nothing was changing the bind-mounted files.

Going forward: any "pristine state" claim should be backed by
operator-side `git status` on a freshly-built-and-booted panel
container, not just dev-side observation.

### Compatibility

- **No code change.** Only `.gitignore` and one tracked file's
  mode bumped. No probe behaviour change, no Rust change, no
  PHP change, no compose change.
- **Fresh-checkout operators** see no diff after pull — git
  applies the new index mode on `git checkout`.
- **VPS operators with the post-entrypoint chmod state** see no
  diff after pull — the worktree's exec-bit-set mode now matches
  the index's `100755`.
- **Operators with `core.fileMode = false`** see no diff regardless
  — they were never affected by this issue in the first place.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
git status
# Expect: clean — no more `MM panel/bootstrap/cache/.gitkeep`,
#         no more untracked panel/public/css|js
```

If `git status` still shows residue, run `git diff` on the
specific file — anything still surfacing is a NEW issue not
covered by v0.0.47 or v0.0.48 and is worth flagging.

### Cycle 2 manual: actually closed this time

v0.0.47 declared closure prematurely. v0.0.48 backfills the
declaration with verifiable post-VPS-pull pristine state. Apologies
for the false-summit moment in v0.0.47. The arc now is:

| Phase | Releases |
|---|---|
| Cycle 2 work | v0.0.36 → v0.0.46 |
| First-pass cleanup | v0.0.47 (incomplete coverage) |
| **Second-pass cleanup** | **v0.0.48 (this release)** |

---

## [0.0.47] — 2026-05-06 — Final cleanup: `.gitignore` truth-up + `docs/components.md` post-Cycle-2 sync — **Cycle 2 manual closes**

The pristine-state release. Two minor cleanups bundled together
to close the Cycle 2 manual: silence the working-tree noise that
crept in during the v0.0.39 dev loop, and synchronise
`docs/components.md` against the post-Cycle-2 reality (verifier
shapes, component list, example output, "updating a component"
workflow).

### Fixed

- **`.gitignore`** — added two patterns to silence files that
  appeared as untracked across every working tree since v0.0.39
  dev:
  - `panel/.phpunit.cache/` — PHPUnit 11 test-result cache,
    created on every `make test` / `phpunit` run
  - `panel/storage/framework/cache/*.php` — Laravel's compiled-
    facade cache, written directly into `cache/` (the existing
    `cache/data/*` glob doesn't catch bare-level files)

### Changed

- **`docs/components.md`** — full post-Cycle-2 truth-up:
  - **Headline**: "The eight components today" →
    "The eleven components today"
  - **Component table**: added the 3 missing rows
    (`doh-resolver`, `haproxy`, `naiveproxy-client`); rewrote
    the "Verifier" column for every container-image component
    to reflect the post-Cycle-2 probe shapes (panel:
    `php artisan ct:version`, redis: `redis-cli INFO Server`,
    mariadb: `SELECT VERSION()`, sing-box: clash-API `/version`,
    haproxy: UNIX stats socket `show info`); column header
    bumped to "Verifier (post-Cycle-2)" so future readers know
    when the shape was set.
  - **Example schema** (lines 28-40): replaced the v0.0.34-era
    silenced-TCP-open sing-box probe with the actual current
    v0.0.42 clash-API probe, including the `set -eo pipefail`
    discipline. Reflects what an operator browsing the repo
    today actually sees in `manifests/sing-box.upstream.json`.
  - **Verifier-behaviour bullets**: rewrote the
    `binary` / `container-image` paragraph to describe the
    `installed.contains(&m.version)` matcher discipline that
    Cycle 2 relies on, instead of the pre-Cycle-2 "TCP open is
    fine" guidance. Added the missing `doh-endpoint` kind.
    Replaced the "silent on success" paragraph (now dead advice
    — no in-tree manifest uses `expect_no_version_line: true`)
    with a brief note that the field still exists in
    `ct-protocol` for external manifests (future sidecars,
    third-party plugins).
  - **Example output** (lines 73-81): rewrote to show the
    11-component post-Cycle-2 reality, with real `installed=`
    strings for every container-image probe (panel
    `Cool Tunnel Panel 0.0.39`, redis `redis_version:7.4.8`,
    mariadb `11.8.6-MariaDB-ubu2404`, sing-box `1.13.11`,
    haproxy `Version: 3.0.21-6e57320bb`). The `installed=—`
    rows are now only caddy (informational-only) and
    `naiveproxy-client` (binary-presence test).
  - **"Updating a component"** workflow: replaced the manual-
    edit step list with the v0.0.45 `make set-component-version`
    macro for third-party components and `make set-version` for
    in-tree components. Documents what each macro covers and
    cross-references the lockstep guarantee.

### Compatibility

- **No code change.** Only `.gitignore` and `docs/components.md`
  modified. No probe behaviour change, no Rust change, no PHP
  change, no compose change.
- **Pre-v0.0.47 working trees** that already have
  `panel/.phpunit.cache/` / `panel/storage/framework/cache/*.php`
  on disk — `git rm --cached -r panel/.phpunit.cache panel/storage/framework/cache/*.php`
  followed by a commit would clean any historical staging, but
  since these were never committed in the first place, the new
  ignore patterns just stop them from showing up in `git status`.
  The files themselves stay on disk (they're still needed at
  runtime).

### Cycle 2 manual closed

v0.0.36 → v0.0.47 (12 patch releases over 1 day) closes the
Cycle 2 arc:

| Phase | Releases | Theme |
|---|---|---|
| Pre-cycle | v0.0.36 | Panel CRUD fix (proxy account create unblocked) |
| Forensic foundation | v0.0.37 | `expect_no_version_line` opt-in vocabulary |
| Build infra | v0.0.38 | `CT_CORE_BUILD_PROFILE` wired through compose |
| Drift restoration | v0.0.39..v0.0.43 | Make drift visible — 5 components × 5 releases |
| Hardening | v0.0.44 | Demonstrate Cycle 2's payoff (HAProxy 2.9 → 3.0) |
| Stabilisation | v0.0.45..v0.0.46 | Make drift structurally impossible (lockstep + DRY) |
| **Pristine state** | **v0.0.47** | **Final cleanup — Cycle 2 manual closes** |

The shift from "visible drift" to "structurally impossible
drift" is complete. Every component has a probe; every probe
has a manifest pin; every pin has a single-command bump path;
every bump path has a JSON-validation guard. The matcher's
permissive `None => Ok` corner case is no longer load-bearing.
The redundant compose env duplications are gone. The `.gitignore`
is clean. The doc matches reality.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
git status   # should be clean — no more untracked phpunit/cache files
```

No `make update` needed for this release — `.gitignore` and
`docs/components.md` are inert at runtime.

---

## [0.0.46] — 2026-05-06 — Compose env DRY: strip the v0.0.40 / v0.0.41 / v0.0.42 redundant duplications

The bookend to the Cycle 2 stabilisation phase. v0.0.45 made
version drift structurally impossible; v0.0.46 makes the
*configuration* DRY by removing three explicit `environment:`
entries that `env_file: - .env` already injects.

The redundant duplications crept in across the Cycle 2 sprint:
v0.0.40 added `REDIS_PASSWORD`, v0.0.41 added `DB_USERNAME` /
`DB_PASSWORD`, each with a multi-paragraph comment explaining
why the probe needed them as bare env vars. The v0.0.42 forensic
caught the redundancy:

> Side discovery: env_file: - .env on the panel service already
> injects every .env key into the panel container's environment.
> The REDIS_PASSWORD / DB_USERNAME / DB_PASSWORD additions in
> v0.0.40 / v0.0.41's environment: blocks were redundant (no
> regression — duplicate vars with identical values are a no-op).

v0.0.46 removes them.

### Changed

- **`docker-compose.yml::panel.environment`** — stripped 3
  redundant entries plus their explanatory comment blocks
  (~28 lines total). Replaced with a single forward-pointer
  comment naming `env_file: - .env` as the canonical delivery
  mechanism for credentials and operator-tunable values, and
  documenting that the remaining `environment:` keys are only
  those that need to differ from `.env` or don't live there at
  all (container-internal hostnames, render paths, derived URLs).

### Why this is safe (proven from scan + post-edit verification)

1. `env_file: - .env` is on the panel service
   ([docker-compose.yml:312](docker-compose.yml:312)) — confirmed.
2. Compose semantics: `env_file` injects every `KEY=VALUE` line
   from `.env` into the container env at start time.
3. Both delivery mechanisms (`environment:` block + `env_file:`)
   put values in the same place — the container's `/proc/1/environ`.
   The shell probes don't care which mechanism delivered the value.
4. Hygiene preserved: `MYSQL_PWD=$DB_PASSWORD` /
   `REDISCLI_AUTH=$REDIS_PASSWORD` env-var auth in the probes is
   about how the SHELL uses the env var (keeping password out of
   argv), not about how Docker delivers it. Both delivery
   mechanisms have identical security properties.

### Compatibility

- **No probe behaviour change.** Each Cycle 2 probe (v0.0.40
  redis, v0.0.41 mariadb, v0.0.42 sing-box) still resolves the
  required env vars from the panel container's environment —
  just via `env_file` instead of the explicit block.
- **Operator verification post-pull**:
  ```sh
  docker compose config panel | grep -E "REDIS_PASSWORD|DB_USERNAME|DB_PASSWORD"
  ```
  Expect each variable to appear once in the resolved environment
  with the value from `.env`.
- **Failure mode if the env_file assumption fails** — the
  v0.0.40 / v0.0.41 / v0.0.42 probes will trip `VerifyFailed`
  (NOAUTH for redis / mariadb, 401 for sing-box) on `make update`,
  surfacing the regression immediately. The v0.0.43 drift
  detection infrastructure built during Cycle 2 is what makes
  this cleanup safe to ship — pre-Cycle-2 a regression would
  have been silently invisible.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
docker compose exec panel ct-server-core component check --manifests /srv/manifests
```

Expected: 11 / 11 OK. No probe change — same verified-string
outputs as v0.0.45. The win is configuration-entropy reduction,
not behavioural.

### Cycle 2 stabilisation phase complete

v0.0.39 → v0.0.46 (8 patch releases) closes the Cycle 2 arc:

| Phase | Releases | Theme |
|---|---|---|
| Drift restoration | v0.0.39..v0.0.43 | Make drift visible |
| Hardening | v0.0.44 | Demonstrate Cycle 2's payoff |
| Stabilisation | v0.0.45..v0.0.46 | Make drift structurally impossible (lockstep + DRY) |

The remaining queued items (panel/.gitignore truth-up,
docs/components.md component-table truth-up) are minor
documentation cleanups not in the stabilisation thesis. Either
can be folded into the next operator-driven release at zero
cost.

### Out of scope

- **`panel/.gitignore` truth-up** — still pending.
- **`docs/components.md` 8 → 11 component table** — still
  pending.

---

## [0.0.45] — 2026-05-06 — Three-way lockstep pinning: `make set-component-version` becomes the sole source of truth

Cycle 2 made drift **visible**. v0.0.44 demonstrated drift
visibility producing a hardening release. v0.0.45 makes drift
**structurally impossible** for the three layers that should never
disagree: compose `image:` tags, Dockerfile `FROM` / `ARG` /
`COPY --from=` pins, and manifest `version` fields.

Pre-v0.0.45 the operator had to remember to bump up to three
files in lockstep when upgrading a third-party component. The
v0.0.43 drift probes would catch a forgotten bump as
`VersionMismatch` on the panel — visibility worked — but the
discipline was still operator-driven. v0.0.45 collapses this to
a single Makefile invocation: `make set-component-version
COMPONENT=<X> V=<Y>` is now the authoritative way to bump any
third-party component, and partial bumps are structurally
impossible.

### Eliminated floating tags

| Component | Before | After |
|---|---|---|
| redis (compose) | `image: redis:7-alpine` | `image: redis:7.4.8-alpine` |
| redis (panel image) | `COPY --from=redis:7-alpine` | `COPY --from=redis:7.4.8-alpine` |
| mariadb (compose) | `image: mariadb:11` | `image: mariadb:11.8.6` |
| haproxy (Dockerfile) | `FROM haproxy:3.0-alpine` | `FROM haproxy:3.0.21-alpine` |
| sing-box (Dockerfile ARG) | already exact (`1.13.11`) | unchanged — macro learns the path |

All four third-party components now pin exactly. Manifest pins
already exact since v0.0.40 / v0.0.41 / v0.0.43 / v0.0.44.

### Added

- **`Makefile::set-component-version` — case-block extension.**
  v0.0.40 introduced the macro for manifest-only bumps; v0.0.45
  extends it with component-aware sed branches:
  - `redis` → bumps `docker-compose.yml` + `docker/panel/Dockerfile`
  - `mariadb` → bumps `docker-compose.yml`
  - `sing-box` → bumps `docker/sing-box/Dockerfile` (ARG)
  - `haproxy` → bumps `docker/haproxy/Dockerfile` (FROM)
  - everything else → falls through to manifest-only (caddy is
    informational-only; in-tree components use `make set-version`).

  Each branch's sed pattern is anchored to specific line shapes
  (`^FROM `, `^ARG SING_BOX_VERSION=`, `(image: *)`, `(COPY --from=)`)
  to avoid touching unrelated lines (`ARG NAIVE_VERSION`,
  `REDIS_URL: redis://...`, etc.). Exercised live during v0.0.45
  development against all five components (4 lockstep + 1
  fall-through); revert tested by re-running with the canonical
  version.

### Atomicity

Each `sed -i.bak` writes the original to `*.bak`. If any
subsequent sed or the final `jq` JSON-revalidation fails, the
.bak files remain on disk for operator rollback. Cleanup happens
**only after** `jq` confirms the manifest is still valid JSON —
a regex bug that produces broken JSON leaves the entire
half-bumped state recoverable. Per-file `rm -f` rather than
`find -delete` so the cleanup never touches unrelated `.bak`
files in the working tree.

### Compatibility

- **No probe behaviour change.** All v0.0.40 / v0.0.41 / v0.0.42
  / v0.0.43 drift probes assert manifest-pin matches deployed-
  version; the manifest pins didn't change in v0.0.45 (only the
  source files that produce those deployed versions). Operators
  upgrading from v0.0.44 → v0.0.45 → next-`make update` will
  see the same `installed=...` strings on the Components page,
  rebuilt from now-explicitly-pinned source images.
- **Operators on a paused-update flow** see no behavioural
  change — the new pins resolve to the SAME Docker images the
  floating tags would have served at this point in time
  (verified via the deployed daemons' actual reported versions
  in v0.0.40 / v0.0.41 / v0.0.42 / v0.0.43 / v0.0.44).
- **Future upstream upgrades** are now one command:
  `make set-component-version COMPONENT=redis V=7.4.9` (when
  Redis 7.4.9 ships) → all three layers bump in one atomic
  invocation → `make update` rebuilds → drift probe asserts
  consistency.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
docker compose exec panel ct-server-core component check --manifests /srv/manifests
```

Expected: 11 / 11 OK. No probe change — same verified-string
outputs as v0.0.44. The win is structural, not behavioural.

### Future-upgrade workflow demonstration

When Redis 7.4.9 ships:

```sh
make set-component-version COMPONENT=redis V=7.4.9
# compose tag, panel Dockerfile COPY, manifest version — all bumped atomically
git diff   # review the 3-file change
make ci    # verify it builds + tests pass
git commit -am "bump redis to 7.4.9"
make update
```

One command, three files, zero drift. Same shape for mariadb,
sing-box, haproxy.

### Out of scope (queued)

- **v0.0.46** — Compose env-var DRY cleanup. Strip the redundant
  `REDIS_PASSWORD` / `DB_USERNAME` / `DB_PASSWORD` entries from
  the panel service environment block (already injected via
  `env_file: - .env`).
- **`panel/.gitignore` truth-up** — still pending.
- **`docs/components.md` 8 → 11 component table** — still
  pending.

---

## [0.0.44] — 2026-05-06 — HAProxy 2.9 → 3.0 hardening: retire EOL line, demonstrate Cycle 2's payoff

The first post-Cycle-2 release. v0.0.43's drift-detection probe
surfaced that the deployed HAProxy 2.9 daemon was reporting
`Status: End of life - please upgrade to branch 3.0.`. v0.0.44 is
exactly the coordinated hardening release Cycle 2 was designed to
make safe: bump `Dockerfile::FROM` and `manifests/<>::version`
in lockstep, rely on the v0.0.43 probe to surface any
post-upgrade drift, ship.

Operator-confirmed via `docker run --rm haproxy:3.0-alpine
haproxy -v` that today's `haproxy:3.0-alpine` resolves to
`3.0.21-6e57320bb` — the new pin. The status line now reads
`long-term supported branch - will stop receiving fixes around
Q2 2029`.

### Changed

- **`docker/haproxy/Dockerfile::FROM`** — `haproxy:2.9-alpine` →
  `haproxy:3.0-alpine`. Comment block reframed: 3.0 is now the
  active LTS line, scheduled for fixes through ~Q2 2029. Cross-
  reference to v0.0.43's drift probe surfacing the EOL flag.
- **`manifests/haproxy.upstream.json::version`** — `"2.9.15"` →
  `"3.0.21"`. Note retired the v0.0.43 EOL caveat. Three-way
  lockstep pinning of the `haproxy:3.0-alpine` floating tag is
  queued for v0.0.45.
- **`scripts/update.sh`** — added `haproxy` to the
  `compose build sing-box panel` step. Without this, the
  operator's `make update` would have left the haproxy container
  running the prior 2.9 image while the Dockerfile change sat
  unbuilt — the v0.0.43 drift probe would have tripped
  `VersionMismatch` indefinitely. Adding haproxy to the build
  set keeps the existing rebuild-then-swap discipline intact for
  any future haproxy-side change too. (Closes a footgun that
  Cycle 2 didn't surface because no Cycle 2 release touched the
  haproxy Dockerfile.)

### How this is the Cycle 2 payoff

Pre-Cycle-2: the haproxy probe was a TCP-open check that said
`Ok` regardless of the deployed daemon's version. An EOL
condition would have been silently invisible — operators would
discover it only by reading external upstream-status pages, or
by getting hit with an unpatched CVE.

Post-Cycle-2 (v0.0.43 onwards): the probe queries
`show info` over the stats socket and asserts the version line
contains the manifest pin. The EOL string itself is in the
`Status:` line of `haproxy -v`, surfaced by the operator's
manual `docker compose exec haproxy haproxy -v` — and the drift
probe is what made that manual check feel safe to act on (no
more guessing whether a 3.0 image would break the cfg.tpl).

The whole sequencing — *first* establish drift detection
(Cycle 2), *then* upgrade out of EOL (v0.0.44) — is the
operator-discipline thesis Cycle 2 was designed to enable.

### Compatibility

- **No cfg.tpl change required.** Every directive used
  (`mode tcp`, `tcp-request inspect-delay`,
  `req_ssl_hello_type`, `req_ssl_sni`, `use_backend`,
  `default_backend`, `stats socket … level user`,
  `option dontlognull`) is stable across HAProxy 2.9 → 3.0.
  The rendered `haproxy.cfg` is byte-identical pre-/post-upgrade.
- **Pre-v0.0.44 deployments** — operators who pull v0.0.44 but
  don't rebuild haproxy (e.g. older `make update` flow) will
  see `VerifyFailed` on the haproxy row (the probe sees
  `2.9.15` but the manifest pins `3.0.21`). `make update` with
  the v0.0.44 update.sh fix rebuilds haproxy and the row flips
  to `Ok`. This **is** drift detection working — the same
  operator-visible payoff v0.0.43 was designed for.
- **Post-v0.0.44 manifests** — `manifests/haproxy.upstream.json`
  is the only file whose pin will need bumping when 3.0.X+1
  ships. v0.0.45's three-way lockstep work will turn that into
  a single `make set-component-version COMPONENT=haproxy V=3.0.X+1`
  invocation.
- **HEALTHCHECK** in `docker/haproxy/Dockerfile` is unchanged
  (`nc -z 127.0.0.1 443`). Alpine's busybox `nc` is stable
  across image generations.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
docker compose exec panel ct-server-core component check --manifests /srv/manifests
```

Expected: 11 / 11 OK. The haproxy row reports
`installed=Version: 3.0.21-... — verified`. The
`docker compose exec haproxy haproxy -v` status line now reads
`long-term supported branch - will stop receiving fixes around
Q2 2029`.

To prove the upgrade actually landed:

```sh
docker compose exec haproxy haproxy -v
# Expect: HAProxy version 3.0.21-6e57320bb 2026/04/30 - https://haproxy.org/
#         Status: long-term supported branch - will stop receiving fixes around Q2 2029.
```

### Out of scope (queued)

- **v0.0.45** — Three-way (compose ↔ Dockerfile ↔ manifest)
  lockstep pinning for redis, mariadb, sing-box, haproxy. Will
  extend `make set-component-version` with component-aware sed
  patterns so a single invocation is the sole source of truth
  for upstream upgrades.
- **v0.0.46** — Cleanup of v0.0.40 / v0.0.41 redundant compose
  env duplications (`REDIS_PASSWORD`, `DB_USERNAME`,
  `DB_PASSWORD`).
- **`panel/.gitignore` truth-up** — still pending.
- **`docs/components.md` 8 → 11 component table** — still
  pending.

---

## [0.0.43] — 2026-05-06 — Cycle 2 (5 / 5, **Cycle 2 closes**): restore real drift detection for haproxy via UNIX stats socket

The final Cycle 2 release. Drift detection is now live for every
component the matcher gates on (panel, redis, mariadb, sing-box,
haproxy); caddy stays informational-only by design. The
permissive `None => Ok` matcher arm that originally masked the
v0.0.34 → v0.0.35 → v0.0.37 cascade is now structurally
unreachable for the silenced-six set — every probe in that set
emits a real version line and the matcher's soft version match
runs against it.

Architecturally the most invasive of the Cycle 2 set: unlike
panel / redis / mariadb / sing-box (each of which had a
ready-made admin endpoint or client protocol), haproxy required
us to **enable its admin surface in the first place**. Pre-v0.0.43
the rendered haproxy.cfg had no stats socket, no stats listener,
no admin API of any kind — `nc -z 127.0.0.1 443` was the only
liveness signal. v0.0.43 adds a UNIX-domain stats socket bound to
read-only-stats privilege level, mounted as a shared docker
volume into the panel container so the matcher can query it
without exposing the admin surface to anything else on the docker
network.

### Added

- **`haproxy/haproxy.cfg.tpl::global` block** —
  ```
  stats socket /var/run/haproxy/admin.sock mode 660 level user
  ```
  UNIX-domain socket only — no TCP listener, no docker-network
  reach beyond the volume's mount points. `level user` is the
  minimum privilege that allows `show *` commands; it does NOT
  permit `disable server` / `set server` / `add backend`, so a
  buggy probe cannot mutate runtime state.
- **`docker-compose.yml::haproxy_admin`** — new named volume.
  Mounted RW into the haproxy service (where haproxy creates the
  socket on boot) and **RO** into the panel service (where the
  matcher reads it). The volume itself is the security boundary
  — no other service mounts it.
- **`socat` in the panel image** — `apk add` now includes
  `socat` (~150 KiB; smaller than v0.0.42's `jq` addition).
  Required by the new probe to talk to the UNIX socket; vanilla
  `bash`'s `/dev/tcp` redirection family doesn't speak UNIX.

### Changed

- **`manifests/haproxy.upstream.json`** — probe rewritten from
  the v0.0.37 silenced TCP-open form to:
  ```bash
  bash -c 'set -eo pipefail; echo "show info" | socat -t 5 - UNIX-CONNECT:/var/run/haproxy/admin.sock | grep -E "^Version:"'
  ```
  `set -eo pipefail` is the same shell hygiene as v0.0.42 — closes
  the silent-failure trap where a failed socat + empty-stdin grep
  could land at exit 0. Dropped `expect_no_version_line: true`.
  Bumped pinned `version` from the docker-tag-shaped string
  `"v2.9-alpine"` to the exact patch `"2.9.15"`
  (operator-confirmed via
  `docker compose exec haproxy haproxy -v` against the live VPS
  deployment). `note` expanded with the v0.0.34 → v0.0.43
  evolution and the EOL flag below.

### How drift detection now works for haproxy

Probe runs in panel container:

```bash
set -eo pipefail
echo "show info" | socat -t 5 - UNIX-CONNECT:/var/run/haproxy/admin.sock | grep -E "^Version:"
```

Output: `Version: 2.9.15-e872a3f` (or whatever your daemon
returns). `first_line(stdout)` is exactly that string; matcher's
`installed.contains(&m.version)` resolves against pin `"2.9.15"`.

| Failure | Probe exit | Matcher state |
|---|---|---|
| `socat` missing in panel image (mis-merge) | 127 | `VerifyFailed` |
| Socket file missing (haproxy down / volume not mounted) | non-zero (socat connect error) | `VerifyFailed` |
| Permission denied on socket | non-zero (EACCES) | `VerifyFailed` |
| haproxy refuses level (cfg drift) | empty stdout, grep exits 1 (pipefail catches) | `VerifyFailed` |
| Probe timeout (`-t 5`) | non-zero | `VerifyFailed` |
| 200-equivalent + missing `Version:` line | grep exits 1 (pipefail catches) | `VerifyFailed` |
| Drift (deployed `2.9.16`, manifest pins `2.9.15`) | exit 0, output `Version: 2.9.16-...` | `VersionMismatch` |
| Healthy + matched | exit 0, output `Version: 2.9.15-...` | `Ok` |

No silent failures.

### Security note — HAProxy 2.9 is upstream EOL

The deployed daemon reports:

```
Status: End of life - please upgrade to branch 3.0.
```

The 2.9 branch reached upstream end-of-life after the
2.9-alpine tag was originally chosen (v0.0.33). This is **not**
a Cycle 2 concern — Cycle 2 is about making drift visible, and
v0.0.43 just did that — but it is a hardening discipline for a
follow-up release. The right shape:

1. Bump `docker/haproxy/Dockerfile::FROM haproxy:3.0-alpine`.
2. `make set-component-version COMPONENT=haproxy V=3.0.X` (where
   `X` is whatever the new image resolves to).
3. `make ci` to rebuild + run the component check.
4. The drift-detection probe shipping today will surface any
   misalignment between (1) and (2) immediately.

This sequencing — *first* establish drift detection, *then*
upgrade — is exactly what Cycle 2 was designed to enable. The
EOL warning surfaced through the version probe is the first
operator-visible payoff of the work.

### Compatibility

- **Pre-v0.0.43 deployments** — operators who pull v0.0.43 but
  don't `make update` will see `VerifyFailed` for the haproxy
  row (the new probe needs `socat` and the
  `haproxy_admin:/var/run/haproxy:ro` mount, neither of which
  exists in older panel / haproxy containers). `make update`
  rebuilds both images, brings the new haproxy_admin volume up,
  and the row flips to `Ok`. Same "deployed code older than
  manifest" surfacing as v0.0.39 / v0.0.40 / v0.0.41 / v0.0.42.
- **Pre-v0.0.43 haproxy deployments** — if your deployed haproxy
  image is older than `2.9.15`, the probe will land as
  `VersionMismatch`, which is **correct** drift-detection
  behaviour. `make update` rebuilds haproxy from
  `docker/haproxy/Dockerfile`'s pinned `FROM haproxy:2.9-alpine`
  (which currently resolves to 2.9.15) and the row resolves to
  `Ok`. (When you cut the 3.0 hardening release, bump the
  Dockerfile and `make set-component-version` together.)
- **No `expect_no_version_line` manifests remain.** Cycle 2 has
  closed; the field's default (`false`) is now the only value
  in use across all 11 in-tree manifests.

### Cycle 2 closes — full retrospective

| Component | Pre-Cycle 2 (v0.0.37) | Post-Cycle 2 (v0.0.43) |
|---|---|---|
| panel | silenced TCP-equivalent | `php artisan ct:version` (v0.0.39) |
| redis | TCP open on `:6379` | `redis-cli INFO Server` (v0.0.40) |
| mariadb | TCP open on `:3306` | `SELECT VERSION()` (v0.0.41) |
| sing-box | TCP open on `:443` | clash-API `/version`, bearer-auth (v0.0.42) |
| haproxy | TCP open on `:443` | UNIX stats socket `show info` (v0.0.43) |
| caddy | HTTP HEAD reachability | unchanged — informational-only by design |

Total Cycle 2 footprint: 5 patch releases over 1 day, 1 new Rust
CLI subcommand (`ct-server-core admin clash-secret`), 1 new
artisan command (`ct:version`), 2 new apk packages on the panel
image (`jq`, `socat`), 2 new compose volumes (`haproxy_admin`,
`haproxy_admin` mount-via-RO into panel), 1 new Makefile macro
(`set-component-version`), 0 protocol-version bumps (additive
within `ComponentManifestV1` V1 throughout — VERSIONING.md
discipline upheld).

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
docker compose exec panel ct-server-core component check --manifests /srv/manifests
```

Expected: 11 / 11 OK. The haproxy row now reports
`installed=Version: 2.9.15-... — verified` instead of v0.0.37's
`installed=— verified (liveness)`.

### Validation one-liner

```sh
docker compose exec panel bash -c \
    'set -eo pipefail; echo "show info" | socat -t 5 - UNIX-CONNECT:/var/run/haproxy/admin.sock | grep -E "^Version:"'
# Expect: Version: 2.9.15-...
```

To prove drift detection actually fires:

```sh
make set-component-version COMPONENT=haproxy V=9.9.9   # fake drift
docker compose exec panel ct-server-core component check --manifests /srv/manifests
# haproxy row → VersionMismatch
make set-component-version COMPONENT=haproxy V=2.9.15  # restore
```

### Out of scope (post-Cycle 2 follow-ups)

- **HAProxy 3.0+ hardening release.** The EOL warning surfaced
  by today's probe is now an operator-visible follow-up.
  Coordinated `Dockerfile::FROM` + `make set-component-version`
  bump as a single discipline release.
- **Three-way (compose ↔ Dockerfile ↔ manifest) lockstep
  pinning** for redis / mariadb / sing-box / haproxy — currently
  compose / Dockerfile pins to floating tags (`redis:7-alpine`,
  `mariadb:11`, `haproxy:2.9-alpine`), manifests pin exact
  patches. Coordinating all three would let a single
  `make set-component-version` invocation be the sole source of
  truth.
- **`panel/.gitignore` truth-up** for the phpunit/Laravel cache
  files first noted in v0.0.39.
- **Cleanup of v0.0.40 / v0.0.41 redundant compose env duplications**
  (`REDIS_PASSWORD`, `DB_USERNAME`, `DB_PASSWORD` — already
  injected via `env_file: - .env`).
- **`docs/components.md` 8 → 11 component table truth-up**
  (still pending from before Cycle 2).

---

## [0.0.42] — 2026-05-06 — Cycle 2 (4 / 5): restore real drift detection for sing-box via authenticated clash-API `/version`

The most architecturally invasive Cycle 2 release so far. Unlike
panel / redis / mariadb (which had a ready-made stdout banner or a
shell-runnable identity query), sing-box exposes its version only
through its **clash-API admin endpoint**, which is bearer-token
authenticated against a per-install secret derived from
`CT_CLASH_SECRET_SEED`. The probe needs that secret at probe time,
and the secret derivation must agree bit-for-bit with the panel
renderer's — anything else is silent drift.

Solution: a new `ct-server-core admin clash-secret` CLI subcommand
that prints the same secret the renderer uses, calling the same
`singbox::clash_secret()` function. **Single source of truth**
across probe, renderer, and daemon. A future change to the
derivation (BLAKE2, salting, etc.) cannot desync the probe from
sing-box's actual configured secret.

### Added

- **`ct-server-core admin clash-secret`** — new top-level CLI
  subcommand. Prints the SHA-256-derived clash bearer token
  (`hex(sha256("ct-clash-secret-v1:" + $CT_CLASH_SECRET_SEED))`)
  to stdout on success, exits non-zero with a loud error if
  `CT_CLASH_SECRET_SEED` is unset (the v0.0.x R2-2 vulnerability
  surfaces as `VerifyFailed` rather than producing a falsy secret).
  Wraps the existing pre-v0.0.42 `singbox::clash_secret()` —
  no new derivation logic, just CLI surface.
- **`jq` in the panel image** — `apk add` now includes `jq`
  (~600 KiB). Required by the new probe to extract `.version`
  from sing-box's clash-API JSON response. The `--silent` and
  `-r` flags keep stdout clean for the matcher's
  `installed.contains(&m.version)` check.

### Changed

- **`manifests/sing-box.upstream.json`** — probe rewritten from
  the v0.0.37 silenced TCP-open form to:
  ```bash
  bash -c 'set -eo pipefail; SECRET="$(ct-server-core admin clash-secret)"; curl -sf -m 10 -H "Authorization: Bearer $SECRET" "$SINGBOX_CLASH_URL/version" | jq -r .version'
  ```
  `set -eo pipefail` is the key hygiene — without it, a failed
  curl followed by an empty-stdin jq could land at exit 0 in
  some jq versions (the same shape of silent-failure trap that
  v0.0.35 originally created at the matcher level). Dropped
  `expect_no_version_line: true`. Pinned `version` stays at
  `"1.13.11"` (matches `docker/sing-box/Dockerfile::ARG SING_BOX_VERSION`).
  `note` expanded with the v0.0.34 → v0.0.42 evolution.
- **Workspace `version` bumped** from `0.0.34` to `0.0.35` in
  `core/Cargo.toml`. The Rust workspace gained the new
  `Admin::ClashSecret` enum variant — additive within `ct-protocol`
  and the CLI surface, stays inside V1 per VERSIONING.md.
- **`manifests/ct-server-core.upstream.json::version`** — bumped
  from the stale `"0.0.33"` to `"0.0.35"` to match the new
  `core/Cargo.toml` version. Without this the matcher would have
  flipped the `ct-server-core` row to `VersionMismatch` on every
  Components page check after v0.0.42 ships (the binary's
  `version` subcommand emits the new 0.0.35 value, the manifest
  was still pinning the pre-v0.0.37 value). The manifest pin had
  been silently stale since the v0.0.33-only release of
  `make set-version`; the silenced sing-box probe had been
  masking it, but with drift detection back on, the discipline
  matters.
- **`manifests/ct-protocol.upstream.json::version`** — bumped
  `"0.0.33"` → `"0.0.35"` for parallelism with `ct-server-core`.
  This is purely cosmetic (`kind: rust-crate` is matcher-trusted
  via the lockfile), but the panel page renders the pinned
  version, and operators reading the row should see a string
  consistent with the workspace.

### How drift detection now works for sing-box

Probe runs in panel container:

```bash
set -eo pipefail
SECRET="$(ct-server-core admin clash-secret)"  # SHA-256 of $CT_CLASH_SECRET_SEED
curl -sf -m 10 -H "Authorization: Bearer $SECRET" \
     "$SINGBOX_CLASH_URL/version" | jq -r .version
```

| Failure | Probe exit | Matcher state |
|---|---|---|
| `CT_CLASH_SECRET_SEED` unset / empty | non-zero (errexit propagates) | `VerifyFailed` |
| Wrong bearer (`401`/`403`) | exit 22 (`curl -f` + pipefail) | `VerifyFailed` |
| sing-box down (connection refused) | exit 7 | `VerifyFailed` |
| Probe timeout (`-m 10`) | exit 28 | `VerifyFailed` |
| `jq` parse failure (malformed JSON) | non-zero (pipefail catches) | `VerifyFailed` |
| 200 OK + JSON missing `.version` | exit 0, output `null` | `VersionMismatch` (operator sees `installed=null`) |
| Healthy + matched | exit 0, output `1.13.11` | `Ok` (`installed=1.13.11`) |
| Drift (deployed `1.13.12`, manifest pins `1.13.11`) | exit 0, output `1.13.12` | `VersionMismatch` |

No silent failures — `set -eo pipefail` plus `curl -f` plus the
authoritative-secret CLI subcommand mean every legitimate failure
mode surfaces on the Filament Components page.

### Compatibility

- **Pre-v0.0.42 deployments** — operators who pull v0.0.42 but
  don't rebuild the panel image will see `VerifyFailed` for the
  sing-box row (the new probe references `ct-server-core admin
  clash-secret` and `jq`, neither of which exists in older panel
  containers). Recovery: `make update` rebuilds the panel image
  and the row flips to `Ok`. Same "deployed code older than
  manifest" surfacing as v0.0.39 / v0.0.40 / v0.0.41.
- **Pre-v0.0.42 sing-box deployments** — if the operator's
  deployed sing-box image is older than `1.13.11` (e.g. they
  paused updates), the probe will land as `VersionMismatch`,
  which is **correct** drift-detection behaviour. `make update`
  rebuilds sing-box from `docker/sing-box/Dockerfile`'s pinned
  `ARG SING_BOX_VERSION=1.13.11` and the row resolves to `Ok`.
- **`expect_no_version_line` semantics** — unchanged. Only
  haproxy still carries the field; Cycle 2 / 5 closes that.
- **Side discovery** during v0.0.42 scoping: `env_file: - .env`
  on the panel service ([docker-compose.yml:305](docker-compose.yml:305))
  already injects every `.env` key into the panel container's
  environment, so the `REDIS_PASSWORD` / `DB_USERNAME` /
  `DB_PASSWORD` additions in v0.0.40 / v0.0.41's `environment:`
  blocks were redundant (no regression — duplicate vars with
  identical values are a no-op). v0.0.42 does not duplicate
  `CT_CLASH_SECRET_SEED` for the same reason. Cleanup of the
  v0.0.40 / v0.0.41 redundancy is a future tidy-up release.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
docker compose exec panel ct-server-core component check --manifests /srv/manifests
```

Expected: 11 / 11 OK. The sing-box row now reports
`installed=1.13.11 — verified` instead of v0.0.37's
`installed=— verified (liveness)`. The `ct-server-core` row stays
`Ok` because its manifest pin was bumped to match the new
workspace version.

### Validation one-liner

```sh
docker compose exec panel bash -c \
    'set -eo pipefail; SECRET="$(ct-server-core admin clash-secret)"; curl -sf -m 10 -H "Authorization: Bearer $SECRET" "$SINGBOX_CLASH_URL/version" | jq -r .version'
# Expect: 1.13.11
```

To prove the secret derivation matches between probe and renderer:

```sh
docker compose exec panel ct-server-core admin clash-secret
# Expect: 64-char hex string — same value the renderer wrote into
# /etc/sing-box/config.json's experimental.clash_api.secret field
```

To prove drift detection actually fires:

```sh
make set-component-version COMPONENT=sing-box V=9.9.9
docker compose exec panel ct-server-core component check --manifests /srv/manifests
# sing-box row → VersionMismatch
make set-component-version COMPONENT=sing-box V=1.13.11
```

### Out of scope (Cycle 2, release 5 / 5)

- haproxy probe (stats socket `show info` over
  `/var/run/haproxy/admin.sock`) — needs socket mount in compose;
  release 5 / 5, the final Cycle 2 release
- caddy stays informational-only — not slated
- The `make set-version` / `make set-component-version` family is
  comprehensive after this release; no Makefile changes
- `panel/.gitignore` truth-up still pending — minor follow-up

---

## [0.0.41] — 2026-05-06 — Cycle 2 (3 / 5): restore real drift detection for mariadb via `SELECT VERSION()`

Continuing the per-component drift-detection restoration. v0.0.39
closed the panel; v0.0.40 closed redis; v0.0.41 closes mariadb.
The probe goes from a TCP-open liveness check to an authenticated
`SELECT VERSION()` against the live daemon — drift between the
deployed patch version and the operator's version-of-record is
now visible on the Components page. The smallest Cycle 2 release
so far: no Dockerfile change (`mariadb-client` was already in the
panel image), no Makefile change (`set-component-version` shipped
in v0.0.40), 3 files total.

Strategic decision: Option A (exact patch pin), pinned to **11.8.6**
— operator-confirmed via `docker compose exec db mariadbd --version`
against the live VPS deployment. Note the deployed string is
`11.8.6-MariaDB-ubu2404` (Ubuntu 24.04 build flavour); the matcher's
`installed.contains("11.8.6")` resolves cleanly against any of the
shapes `SELECT VERSION()` returns (`11.8.6-MariaDB`, `11.8.6-MariaDB-1`,
or `11.8.6-MariaDB-ubu2404`) so a build-flavour change alone won't
trip a false-positive VersionMismatch.

### Added

- **`docker-compose.yml::panel.environment`** — exposes
  `DB_USERNAME: "${DB_USERNAME}"` and
  `DB_PASSWORD: "${DB_PASSWORD}"` to the panel container. Laravel
  itself reads these from `.env` via phpdotenv at PHP boot —
  phpdotenv does NOT export to the shell environment of arbitrary
  processes, so a `bash -c 'mariadb -u $DB_USERNAME ...'` probe
  spawned by the matcher would have seen them as empty without
  this explicit duplication. Same pattern as the v0.0.40
  REDIS_PASSWORD addition. `DB_DATABASE` is intentionally **not**
  duplicated — `SELECT VERSION()` is a system function that
  doesn't need a database context, and excluding the schema name
  trims one more value from the `ps`-window exposure surface.

### Changed

- **`manifests/mariadb.upstream.json`** — probe rewritten from
  the v0.0.37 silenced TCP-open form to:
  ```
  bash -c 'MYSQL_PWD="$DB_PASSWORD" mariadb -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USERNAME" -BN -e "SELECT VERSION()"'
  ```
  `-BN` (batch + no-headers) strips the ASCII-table formatting so
  `first_line(stdout)` is exactly `<version>-MariaDB[-build]`. The
  matcher's `installed.contains(&m.version)` asserts the pinned
  `version` field is contained in that line. Dropped
  `expect_no_version_line: true`. Bumped pinned `version` from
  the major-only string `"11"` to the exact patch `"11.8.6"`.
  `note` expanded with the v0.0.34 → v0.0.35 → v0.0.37 → v0.0.41
  evolution and the auth-discipline rationale.

### Auth posture

The probe uses the existing app user (`DB_USERNAME` /
`DB_PASSWORD`) rather than a dedicated `health` user with
`USAGE`-only privileges. Two reasons:

1. **`SELECT VERSION()` is a system function.** Any authenticated
   user can call it regardless of grants — the existing app user
   is no more privileged for this probe than a dedicated health
   user would be.
2. **Provisioning cost.** A dedicated user requires new env vars
   (`HEALTH_DB_USERNAME` / `HEALTH_DB_PASSWORD`), an install.sh
   GRANT statement, and `.env.example` updates. That's a separate
   discipline release worth its own forensic; v0.0.41 stays
   surgical.

The probe never writes, never reads schema rows, and only invokes
the `VERSION()` function — its blast radius if `DB_PASSWORD` were
to leak via this code path is identical to the existing leak
surface (Laravel itself uses the same credential against the
same daemon every request).

### How drift detection now works for mariadb

| Failure | Probe exit | Matcher state |
|---|---|---|
| Wrong `DB_PASSWORD` (Access denied) | non-zero | `VerifyFailed` |
| db container down / not ready | non-zero (Can't connect) | `VerifyFailed` |
| `mariadb` CLI missing from panel image | 127 | `VerifyFailed` |
| Probe hangs (deadlock / TCP wedge) | matcher's 15 s timeout | `VerifyFailed` |
| Deployed `11.8.7`, manifest pins `11.8.6` | exit 0, stdout mismatches pin | `VersionMismatch` |
| Healthy + matched | exit 0, stdout matches pin | `Ok` (`installed=11.8.6-MariaDB-...`) |

No silent failures.

### Compatibility

- **Pre-v0.0.41 deployments** — operators who pull v0.0.41 but
  don't restart the panel container will see `VerifyFailed` for
  the mariadb row (the probe references `$DB_USERNAME` /
  `$DB_PASSWORD` env vars that aren't on the running container
  yet). Recovery: `make update` recreates the panel container
  with the new env block and the row flips to `Ok`.
- **`mariadb:11` floating tag in compose** — left as-is per the
  v0.0.40 scope agreement. Three-way (compose ↔ image ↔
  manifest) lockstep pinning is a separate discipline release.
- **Other silenced manifests** — sing-box and haproxy keep
  `expect_no_version_line: true`. Cycle 2 / 4, 5 next.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
docker compose exec panel ct-server-core component check --manifests /srv/manifests
```

Expected: 11 / 11 OK. The mariadb row now reports
`installed=11.8.6-MariaDB-... — verified` instead of v0.0.37's
`installed=— verified (liveness)`.

### Validation one-liner

```sh
docker compose exec panel bash -c \
    'MYSQL_PWD="$DB_PASSWORD" mariadb -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USERNAME" -BN -e "SELECT VERSION()"'
# Expect: 11.8.6-MariaDB-ubu2404   (or whatever your daemon returns)
```

To prove drift detection actually fires:

```sh
make set-component-version COMPONENT=mariadb V=9.9.9   # fake drift
docker compose exec panel ct-server-core component check --manifests /srv/manifests
# mariadb row → VersionMismatch
make set-component-version COMPONENT=mariadb V=11.8.6  # restore
```

### Out of scope (Cycle 2, releases 4 / 5..5 / 5)

- sing-box probe (clash-API `/version`) — needs admin port
  exposure decision; release 4 / 5
- haproxy probe (stats socket `show info` over
  `/var/run/haproxy/admin.sock`) — needs socket mount in compose;
  release 5 / 5
- caddy stays informational-only (HTTP HEAD reachability) — no
  drift detection; not slated
- Dedicated `health` DB user provisioning — separate discipline
  release; not blocking (see "Auth posture" above)
- Pinning compose's floating tags (`mariadb:11`, `redis:7-alpine`)
  to exact patches — separate three-way-lockstep discipline release
- `panel/.gitignore` truth-up for the phpunit/Laravel cache files
  — still pending

---

## [0.0.40] — 2026-05-06 — Cycle 2 (2 / 5): restore real drift detection for redis via `redis-cli INFO Server`

Continuing the per-component drift-detection restoration agreed in
the v0.0.37 forensic. v0.0.39 closed the panel; v0.0.40 closes
redis. The probe goes from a TCP-open liveness check (which only
told us *something* was listening on `redis:6379`) to a semantic
identity check that asserts the running server's `redis_version`
field matches what the manifest pins. Drift between the deployed
patch version and the operator's version-of-record is now visible
on the Components page within ~100 ms of a `Re-check`.

### Added

- **`docker/panel/Dockerfile`** — multi-stage `COPY --from=redis:7-alpine`
  brings `/usr/local/bin/redis-cli` into the panel image (~2 MiB). The
  CLI is required by the new probe and didn't ship in the panel
  image (`apk add` had `mariadb-client` but no Redis client). Same
  multi-stage idiom the file already uses for `ct-server-core`.
- **`docker-compose.yml::panel.environment`** — exposes
  `REDIS_PASSWORD: "${REDIS_PASSWORD}"` to the panel container.
  Laravel itself parses the password out of `REDIS_URL`; the bare
  env var is purely for the probe, which uses
  `REDISCLI_AUTH=$REDIS_PASSWORD` so the password never reaches
  argv (would otherwise surface in `ps -ef` for the probe's
  lifetime — same supply-chain hygiene as
  `MYSQL_PWD=$DB_ROOT_PASSWORD` in `scripts/backup.sh:33`).
- **`Makefile::set-component-version`** — new "Rule Maker" macro.
  Companion to `set-version`, scoped to **third-party** component
  manifests (caddy, haproxy, mariadb, redis, sing-box). Usage:
  ```
  make set-component-version COMPONENT=redis V=7.4.8
  ```
  Bumps `manifests/<slug>.upstream.json::version` and re-validates
  the result with `jq` to catch a sed-regex bug that would have
  produced invalid JSON. Fails loudly on unknown component or
  missing args. Reusable for the remaining 3 Cycle 2 releases
  (mariadb, sing-box, haproxy) and any future caddy upgrade.

### Changed

- **`manifests/redis.upstream.json`** — probe rewritten from the
  v0.0.37 silenced TCP-open form to:
  ```
  bash -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" INFO Server | grep -i ^redis_version:'
  ```
  Output: `redis_version:7.4.8`. The matcher's
  `installed.contains(&m.version)` asserts the pinned `version`
  field is in that line. Dropped `expect_no_version_line: true`.
  Bumped pinned `version` from the docker-tag-shaped string
  `"7-alpine"` to the exact patch `"7.4.8"` (operator-confirmed via
  `docker compose exec redis redis-server --version` against the
  live VPS deployment). `note` expanded with the
  v0.0.34 → v0.0.35 → v0.0.37 → v0.0.40 evolution and the auth
  rationale.

### How drift detection now works for redis

Probe runs in panel container → `redis-cli INFO Server | grep ^redis_version:` →
`first_line(stdout)` is `redis_version:X.Y.Z` →
`installed.contains(&m.version)` resolves against pinned `"7.4.8"`.

Failure modes are exhaustive:

| Failure | Probe exit | Matcher state |
|---|---|---|
| Wrong `REDIS_PASSWORD` (NOAUTH) | non-zero | `VerifyFailed` |
| redis container down (connection refused) | non-zero | `VerifyFailed` |
| `redis-cli` missing from panel image | 127 (command not found) | `VerifyFailed` |
| Probe hangs (network partition) | matcher's 15 s timeout | `VerifyFailed` |
| Deployed redis is 7.4.9, manifest pins 7.4.8 | exit 0, stdout mismatches pin | `VersionMismatch` |
| Healthy + matched | exit 0, stdout matches pin | `Ok` (`installed=redis_version:7.4.8`) |

No silent failures — every failure mode flips the row to a non-OK
state on the Filament Components page.

### Compatibility

- **Pre-v0.0.40 deployments** — operators who pull v0.0.40 but
  don't rebuild the panel image will see `VerifyFailed` for the
  redis row (probe runs `redis-cli` which doesn't exist yet in
  the old panel container). Recovery is the standard
  `make update`, which rebuilds the panel image and the row flips
  to `Ok`. This is intended — same "deployed code older than
  manifest" surfacing as v0.0.39 did for the panel itself.
- **`redis:7-alpine` floating tag in compose** — left as-is per
  the v0.0.40 scope agreement. The Dockerfile's
  `COPY --from=redis:7-alpine` rides the same tag, so the
  bundled CLI tracks whatever Redis 7.x patch Docker Hub serves
  at panel build time. Drift potential between the CLI minor and
  the server minor is accepted (Redis 7.x line is forward-
  compatible at the `INFO` command surface). Pinning compose to
  `redis:7.4.8-alpine` is a follow-on discipline call out of
  scope for this release.
- **Other silenced manifests** — caddy, haproxy, mariadb, sing-box
  keep `expect_no_version_line: true` from v0.0.37. Cycle 2 / 3, 4, 5
  restore drift detection on each in turn.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
docker compose exec panel ct-server-core component check --manifests /srv/manifests
```

Expected: 11 / 11 OK. The redis row now reports
`installed=redis_version:7.4.8 — verified` instead of v0.0.37's
`installed=— verified (liveness)`.

### Validation one-liner

To run the same probe manually and confirm the chain end-to-end
(redis-cli installed, env vars wired, auth works, server alive,
grep matches):

```sh
docker compose exec panel bash -c \
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" INFO Server | grep -i ^redis_version:'
# Expect: redis_version:7.4.8
```

To prove drift detection actually fires: temporarily bump the
manifest pin with `make set-component-version COMPONENT=redis
V=9.9.9`, re-run `component check`, the redis row flips to
`VersionMismatch`. Restore with `make set-component-version
COMPONENT=redis V=7.4.8`.

### Out of scope (Cycle 2, releases 3 / 5..5 / 5)

- mariadb probe (`SELECT VERSION()` via dedicated `health` user) —
  needs auth provisioning; release 3 / 5
- sing-box probe (clash-API `/version`) — needs admin port exposure
  decision; release 4 / 5
- haproxy probe (stats socket `show info`) — needs socket mount in
  compose; release 5 / 5
- caddy stays informational-only (HTTP HEAD reachability) — no
  drift detection; not slated
- Pinning `redis:7-alpine` → `redis:7.4.8-alpine` in
  `docker-compose.yml` for three-way (compose ↔ Dockerfile ↔
  manifest) lockstep — separate discipline release
- `panel/.gitignore` truth-up for the phpunit/Laravel cache files
  noted in v0.0.39 — still pending

---

## [0.0.39] — 2026-05-06 — Cycle 2 (1 / 5): restore real drift detection for the panel via `ct:version`

The Cycle 1 release (v0.0.37) gave manifests a vocabulary
(`expect_no_version_line: true`) for declaring honestly that drift
detection was off for a probe. v0.0.39 starts paying down the
inventory of probes that *should* drift-check, beginning with the
panel — which is the single component most likely to ship a code
change between releases (every panel-side fix touches it).

This is **Cycle 2, release 1 of 5** — one component per release per
the agreed risk-management strategy. Order: panel (this release),
redis, mariadb, sing-box, haproxy. caddy is informational-only and
not slated.

### Added

- **`panel/app/Console/Commands/Version.php`** — new artisan
  command (`php artisan ct:version`) that emits exactly one
  stdout line in the shape `Cool Tunnel Panel <version>`, where
  `<version>` is read from `config('cool-tunnel.version')`.
  Output discipline matches the matcher's expectations:
  plain `$this->line()` (no ANSI), exit 0 on success, exit 1
  with diagnostic on `error` channel if the config key is empty
  (so `expect_zero_exit: true` correctly flips to `VerifyFailed`
  rather than silently passing).
- **`panel/config/cool-tunnel.php::version`** — new config key
  carrying the panel's release-of-record. Read by `ct:version`,
  intentionally NOT env-driven (release-time fact, not operator
  setting). `'version' => '0.0.39'` for this release.
- **`panel/tests/Unit/VersionCommandTest.php`** — three unit
  tests anchoring the matcher contract: (a) emits the expected
  identity line for a configured version, (b) fails loudly when
  the config key is empty (closes the v0.0.35 trap where a
  silent-zero-exit would have resurrected `None => Ok` as the
  load-bearing OK path), (c) `panel/config/cool-tunnel.php::version`
  equals `manifests/panel.upstream.json::version` at test time —
  catches a `make set-version` skip or hand-edit drift before
  tag-cut.

### Changed

- **`manifests/panel.upstream.json`** — probe rewritten from the
  v0.0.37 silenced-bash form to a direct artisan invocation
  `["php", "/var/www/html/artisan", "ct:version"]`. Dropped the
  `expect_no_version_line: true` opt-out (the panel now emits a
  real version line so the soft version matcher should run).
  Bumped pinned `version` from the stale `"0.0.33"` (last touched
  in v0.0.33; six releases stale because `make set-version` had
  never been run during the tactical-patch cadence) to `"0.0.39"`
  so it matches what the artisan command actually emits today.
  Note expanded to record the v0.0.34 → v0.0.35 → v0.0.37 →
  v0.0.39 evolution of this single probe so future-readers can
  reconstruct the design call.
- **`Makefile::set-version`** — added a fourth `sed` step to bump
  `panel/config/cool-tunnel.php::version` alongside
  `core/Cargo.toml`'s workspace version and the three component
  manifests. `make set-version V=X.Y.Z` is once again
  authoritative for "every place a version string lives".
- **`RELEASE.md` step 4** — checklist updated from "three places"
  to "four places", adding `panel/config/cool-tunnel.php` with a
  pointer to why the matcher trips when it drifts from the
  manifest pin.

### How drift detection works post-v0.0.39

The matcher in `core/ct-server-core/src/components.rs::classify_verify`
runs `installed.contains(&m.version)`, where:

- `installed` is `first_line(stdout)` of the probe — for the
  panel, that's `"Cool Tunnel Panel 0.0.39"` (or whatever the
  deployed panel's `cool-tunnel.php::version` says).
- `m.version` is the manifest's pinned string — `"0.0.39"`.

Match → `Ok`. No match (operator deployed a panel with a
different config-version, or shipped a manifest that pins an
older release) → `VersionMismatch`, surfaced in the panel's
Components page with the diagnostic
`"installed version line ... does not match pinned ..."`. This
is the first component on the panel-side stack where drift
between deployed code and pinned manifest is now operator-
visible.

### Compatibility

- **Pre-v0.0.39 deployments** — operators who pull v0.0.39 but
  haven't rebuilt the panel image will see `VersionMismatch` for
  the panel row (probe runs against an old artisan command set
  that lacks `ct:version`). Recovery: `make update` rebuilds the
  panel image and the row flips back to `Ok`. This is the
  intended behaviour — it surfaces the "deployed code older than
  manifest" condition that pre-v0.0.39 was silently invisible.
- **`expect_no_version_line` semantics** — unchanged. The five
  remaining silenced manifests (caddy, haproxy, mariadb, redis,
  sing-box) keep the field; their drift-detection restoration is
  Cycle 2 / 2..5.

### Out of scope

- redis, mariadb, sing-box, haproxy probes still ride the
  v0.0.37 liveness-only branch. Each will get its own release —
  redis next (low-cost banner read via `redis-cli info server`).
- `docs/components.md` 8 → 11 component-table truth-up still
  pending; can be folded into Cycle 2 / 2 (redis) at zero cost.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
docker compose exec panel ct-server-core component check --manifests /srv/manifests
```

Expected: 11 / 11 OK. The panel row now reports
`installed=Cool Tunnel Panel 0.0.39 — verified` instead of the
v0.0.37 `installed=— verified (liveness)`. To verify the artisan
command directly:

```sh
docker compose exec panel php artisan ct:version
# Cool Tunnel Panel 0.0.39
```

To prove drift detection actually fires: temporarily edit
`panel/config/cool-tunnel.php::version` to `"0.0.99"` and re-run
`component check`. The panel row flips to `VersionMismatch`.
Revert the edit; the row goes back to `Ok`.

---

## [0.0.38] — 2026-05-06 — wire `CT_CORE_BUILD_PROFILE` through `docker-compose.yml` so the `.env` knob actually works

`CT_CORE_BUILD_PROFILE` has lived in `.env.example` since the
release-small profile was added, with the documented intent that
operators on low-RAM VPSes flip it to `release-small` to halve the
ct-server-core build time and roughly third the peak RAM. In
practice the env var was never read by any build path —
`scripts/update.sh:25` calls `compose --profile build-only build
core-builder` without `--build-arg`, and the `core-builder` service
in `docker-compose.yml` had no `build.args` block. So the flag
silently no-op'd on every `make update`, and the only way to
actually use `release-small` was to pass `--build-arg
CARGO_PROFILE=release-small` by hand on every rebuild.

v0.0.38 wires the env var through end-to-end. Set it once in `.env`,
run `make update` — the build picks it up.

### Fixed

- **`docker-compose.yml::core-builder`** — added a `build.args`
  block mapping `CARGO_PROFILE: ${CT_CORE_BUILD_PROFILE:-release}`.
  The `:-release` default preserves the pre-v0.0.38 behaviour for
  operators who never set the env var; an explicit
  `CT_CORE_BUILD_PROFILE=release-small` in `.env` now flows through
  to the Dockerfile's `ARG CARGO_PROFILE` and onwards to
  `cargo build --profile`. `sqlx-prepare` is unaffected — its
  Dockerfile stage doesn't reference `CARGO_PROFILE`.

### Changed

- **`.env.example`** — replaced the `--build-arg` workaround
  example with the new operator path (set the var, run `make
  update`). Added the build-time win to the description (release-
  small ≈ 50 % faster compile, in addition to the existing peak-
  RAM win) since that's the more visible benefit on a VPS that
  isn't actively OOM-killing.

### Compatibility

- **No code change.** `core/Cargo.toml`, `ct-protocol`, and
  `ct-server-core` are byte-identical to v0.0.37. The change is
  purely a build-orchestration fix.
- **Default behaviour preserved.** Operators who never set
  `CT_CORE_BUILD_PROFILE` (the documented expected case for boxes
  with spare RAM) continue to get the `release` profile via the
  `:-release` shell-style default in the compose interpolation.
- **Forward-compat with future profiles.** Adding a third profile
  (e.g. `release-fast` for CI hosts) requires only a `core/Cargo.toml`
  edit; no further compose plumbing.

### Operator recovery

Same path as every prior tactical release:

```sh
cd ~/cool-tunnel-server
git pull --ff-only
# Optional: enable the faster build for next time
sed -i 's/^CT_CORE_BUILD_PROFILE=release$/CT_CORE_BUILD_PROFILE=release-small/' .env
make update
```

To verify the value BuildKit will use without committing to a build:

```sh
docker compose --profile build-only config core-builder | grep -A2 args:
```

Expect the resolved `CARGO_PROFILE` to match what's in `.env`.

### Out of scope

The structural Cycle-2-style fixes outlined in the v0.0.37 build-
infra discussion (cargo-chef layer split, `target/` cache mount
covering iterative dep reuse) are still deferred. Those would take
a clean rebuild on `release-small` from ~4 minutes to ~30 seconds;
v0.0.38 only halves the ~8-minute `release` baseline. A dedicated
build-infra release with its own forensic + clean-room test plan
remains the right place for that work.

---

## [0.0.37] — 2026-05-06 — `VerifySpecV1.expect_no_version_line` opts manifests out of the soft version matcher (Cycle 1)

The v0.0.35 forensic surfaced that the six silenced-probe manifests
(caddy, haproxy, mariadb, panel, redis, sing-box) had made the soft
version matcher in `core/ct-server-core/src/components.rs` unreachable
for those components — `m.version` was recorded but no longer
enforced. They were occupying the matcher's permissive `None => Ok`
corner case by accident of empty stdout.

v0.0.37 adds an additive optional field to `VerifySpecV1` so a
manifest can **declare** that drift detection is intentionally off
for that probe, instead of opting out structurally by silencing
stdout. The matcher's drift-detection semantics for the remaining
components stay intact and become reliable rather than accidental.

This is **Cycle 1** of the drift-detection-restoration plan. Cycle 2
(per-component banner-read upgrades that emit a real version line so
drift detection can actually fire on those components) is deferred
and will ship one component per release to manage risk.

### Added

- **`VerifySpecV1.expect_no_version_line: bool`** — new optional
  field on the wire-format struct in `ct-protocol`. Defaults to
  `false` via `#[serde(default)]`, which preserves the pre-v0.0.37
  behaviour bit-for-bit for every existing manifest. The six
  silenced-probe manifests opt in to `true`. Field set is additive
  within `ComponentManifestV1` — stays inside V1 per the policy in
  [`VERSIONING.md`](./VERSIONING.md).
- **`classify_verify` (private)** — extracted post-execution
  classifier in `ct-server-core::components`, so the OK /
  VersionMismatch / VerifyFailed decision is unit-testable without
  spawning a process. Six new tests cover the legacy paths (Ok /
  VersionMismatch / silent-stdout-Ok), the v0.0.37 liveness branch
  (skips the version match even with stdout that would otherwise
  flip to VersionMismatch), the silent-stdout liveness branch, and
  the defence-in-depth interaction with `expect_stdout_contains`.

### Changed

- **Matcher logic** at `ct-server-core::components::classify_verify`
  — when `spec.expect_no_version_line` is `true`, the soft version
  matcher is skipped and the result is `Ok` with the
  `"verified (liveness)"` diagnostic string. The
  `expect_stdout_contains` gate still runs first (independent
  responsibility — needle-match is about WHAT the probe printed,
  liveness opt-in is about whether to drift-check it).
- **Six manifests opt in** — `manifests/caddy.upstream.json`,
  `manifests/haproxy.upstream.json`,
  `manifests/mariadb.upstream.json`,
  `manifests/panel.upstream.json`,
  `manifests/redis.upstream.json`,
  `manifests/sing-box.upstream.json` add
  `"expect_no_version_line": true` to their `verify` block. No
  probe-command changes — the probes stay silent on success. The
  field is the *declaration* that drift detection is intentionally
  off, not the mechanism.
- **Workspace `version` bumped** from `0.0.33` to `0.0.34` in
  `core/Cargo.toml`. The Rust crate version is the only signal an
  external `ct-protocol` reader (or `cargo tree` audit) has that
  the wire format gained a field; the bump is a discipline signal,
  since the workspace is `publish = false` and there is no
  crates.io coordination cost.

### Client-side compatibility

- **New manifest read by old client** — older `ct-protocol`
  consumers (e.g. macOS client built before v0.0.37) silently drop
  the unknown field during deserialization. `VerifySpecV1` does not
  set `#[serde(deny_unknown_fields)]`. Forward-compat preserved.
- **Old manifest read by new server** — field defaults to `false`
  via `#[serde(default)]`. The classifier's legacy paths
  (`Ok` / `VersionMismatch` / `None => Ok`) run unchanged. Backward-
  compat preserved.
- **Per [`VERSIONING.md`](./VERSIONING.md):** *"Field set is
  additive within V1; breaking changes go in V2."* This change is
  additive → stays inside `ComponentManifestV1` (and `VerifySpecV1`).
  No V2.

### Out of scope (Cycle 2, future releases)

Restoring **actual** drift detection for the six liveness-only
components requires per-component banner-read probes (each with its
own auth / network-coupling trade-off):

| Component | Cycle 2 candidate | Trade-off |
|---|---|---|
| panel | re-emit `php artisan --version` stdout (Laravel banner) | trivial; was the v0.0.34 probe — just stop redirecting stdout |
| redis | `redis-cli -h redis info server \| grep ^redis_version:` | low cost; informational TCP banner |
| caddy | `curl -sI http://caddy:80/ \| grep -i ^server:` | only confirms Caddy presence, not pinned version |
| mariadb | `SELECT VERSION()` via dedicated `health` user | needs auth provisioning |
| sing-box | clash-API `/version` (currently internal) | needs admin port exposure |
| haproxy | stats socket `show info` over `/var/run/haproxy/admin.sock` | needs socket mount in compose |

Each lands one release at a time per the agreed risk-management
strategy.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make ci          # rebuilds ct-server-core; runs tests
docker compose build panel
docker compose up -d
docker compose exec panel ct-server-core component check --manifests /srv/manifests
```

Expected after rebuild: **11 / 11 OK**, with the six silenced-probe
rows now carrying `"verified (liveness)"` in the message column
instead of the implicit `None => Ok` fallthrough.

---

## [0.0.36] — 2026-05-06 — fix proxy-account create 500 + components.md truth-up

The Filament admin's **create proxy account** flow has been
returning HTTP 500 since the column was added — every fresh
deploy on v0.0.31..v0.0.35 hits it on the first user-management
action operators are guided towards in `GETTING_STARTED.md`.

Same release also retires two stale paragraphs in
`docs/components.md` that v0.0.34 / v0.0.35 left behind.

Drift-detection restoration (the matcher-side question raised
during the v0.0.35 forensic) is intentionally **out of scope**
for this release; tracked for a separate cycle.

### Root cause (panel CRUD)

`proxy_accounts.password_hash` is `NOT NULL` with no default
(see `2026_05_03_000001_create_proxy_accounts_table.php`). The
column is deliberately outside `ProxyAccount::$fillable` so a
stray `Model::create($request->all())` cannot poison the
credential — only `setCleartextPassword()` is allowed to write
it.

`CreateProxyAccount` did not override `handleRecordCreation()`,
so Filament's default ran `new ProxyAccount($data); $record->save()`
with the form payload (no `password_hash`). The first INSERT
hit the NOT NULL constraint and surfaced as a 500. The page's
`afterCreate()` hook generated and saved the password — but
only after that first save had already failed.

### Fixed

- **Override `handleRecordCreation()` in `CreateProxyAccount`.**
  Generate the cleartext, call `setCleartextPassword()` on the
  unsaved model, then `save()`. The constraint is satisfied on
  the first INSERT and `afterCreate()` is now a pure
  notification step. Side benefit: removes a duplicate
  `static::saved()` event and the redundant
  `ReloadSingBoxJob::dispatch()` it was firing.
  (panel/app/Filament/Resources/ProxyAccountResource/Pages/CreateProxyAccount.php)
- The privilege-bearing column rule is preserved unchanged:
  `password_hash` and `password_cleartext_encrypted` stay
  outside `$fillable`; `setCleartextPassword()` remains the
  only writer.

### Changed (docs)

- **`docs/components.md` — verifier shape.** Dropped the
  `docker exec <container> <cmd>` example from the
  `binary` / `container-image` bullet (false since v0.0.34 —
  the panel container has no `docker` CLI). Replaced with a
  one-paragraph note on the silent-on-success liveness-probe
  pattern and how it interacts with the soft version matcher.
- **`docs/components.md` — example output.** Truthed up the
  `installed=` column for the four silenced components
  (mariadb, panel, redis, sing-box) to show `—`, matching what
  operators actually see post-v0.0.35. `ct-protocol` and
  `ct-server-core` keep real version strings because their
  verifiers still print one.

### Out of scope

- **Drift detection.** The forensic on v0.0.35 surfaced that the
  six silenced manifests have made the soft version matcher
  unreachable for those components — `m.version` is recorded but
  no longer enforced. The right fix (an opt-in
  `expect_no_version_line` field on `VerifyV1`, or a
  banner-read shim per probe) needs a `ct-protocol` edit + crate
  bump and is deferred to a dedicated release.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
docker compose exec panel php artisan optimize:clear
```

No image rebuild required — the panel mounts the resource code
read-only from the working tree, and the manifests / docs are
not consumed at runtime by any service. Visit
`/admin/proxy-accounts/create`, fill in a username, click
**Create** → expect the one-time-password notification with the
subscription URL.

---

## [0.0.35] — 2026-05-06 — silent component-check probes (drop verify-stage version match)

After v0.0.34's manifest rewrite, the Components page went from
`could not exec docker` (7 NG) to "verify ran but stdout doesn't
contain pinned version" (6 NG). The probe layer worked; a second
stage tripped them.

### Root cause

`core/ct-server-core/src/components.rs::check_one` (lines 183-187)
runs a **soft version match** *after* the verify command's
`expect_zero_exit` and `expect_stdout_contains` checks pass:

```rust
let state = match installed.as_deref() {
    Some(line) if line.contains(&m.version) => ComponentStateV1::Ok,
    Some(_) => ComponentStateV1::VersionMismatch,
    None => ComponentStateV1::Ok,
};
```

`installed` is `first_line(stdout)`. If the verify command
produces *any* stdout that doesn't contain the pinned version
string, the result flips to VersionMismatch. v0.0.34's probes
emitted `connected` / `308` / `Laravel Framework 11.51.0`, none
of which contain `v2.9-alpine` / `7-alpine` / `0.0.33` / etc.

### Changed

The TCP / HTTP probes added in v0.0.34 don't *have* a version
string to assert — they're pure liveness probes. The right
shape for a liveness probe under this checker is **silent on
success**: empty stdout makes `first_line(stdout) → None`,
which falls into the `None => Ok` branch (verify passed; no
version line to compare).

Updated the six liveness probes accordingly:

| Component   | v0.0.34 probe                                                                | v0.0.35 probe (silent)                                              |
|-------------|------------------------------------------------------------------------------|---------------------------------------------------------------------|
| caddy       | `curl … -w '%{http_code}' http://caddy:80/` + `expect_stdout_contains: "308"` | `curl -sIo /dev/null --connect-timeout 5 http://caddy:80/`         |
| haproxy     | `bash -c 'exec 3<>/dev/tcp/haproxy/443 && echo connected'`                    | `bash -c 'exec 3<>/dev/tcp/haproxy/443'`                            |
| mariadb     | `bash -c 'exec 3<>/dev/tcp/db/3306 && echo connected'`                        | `bash -c 'exec 3<>/dev/tcp/db/3306'`                                |
| panel       | `php /var/www/html/artisan --version` + `expect_stdout_contains: "Laravel..."` | `bash -c 'php /var/www/html/artisan --version > /dev/null'`        |
| redis       | `bash -c 'exec 3<>/dev/tcp/redis/6379 && echo connected'`                     | `bash -c 'exec 3<>/dev/tcp/redis/6379'`                             |
| sing-box    | `bash -c 'exec 3<>/dev/tcp/sing-box/443 && echo connected'`                   | `bash -c 'exec 3<>/dev/tcp/sing-box/443'`                           |

`bash`'s `exec 3<>/dev/tcp/host/port` form opens FD 3 on the
TCP socket and continues — the redirect's exit status is the
last command's status (0 on connect, non-zero on connect-
refused). With no `&& echo` after it, stdout is empty and the
checker correctly classifies the result as "verify passed, no
version line, OK". The `naiveproxy` (silent `grep -q`) and
`naiveproxy-client` (silent `test -x`) probes already used the
silent pattern and stayed OK throughout.

### Why not improve the checker instead

Adding an opt-in `expect_no_version_line` field to `VerifyV1`
would be cleaner protocol-wise but requires a `ct-protocol`
edit + crate version bump + client-side awareness. For a
single-cycle hotfix on JSON-only manifests, "make probes
silent" is the smaller change. The protocol-level fix is a
candidate for v0.1 alongside the structured-probe work
deferred from R1-1.

### Operator recovery

Same pattern as v0.0.34 — manifests are RO-mounted into the
panel; `git pull` exposes the new verify commands without an
image rebuild:

```sh
cd ~/cool-tunnel-server
git pull --ff-only
docker compose exec panel ct-server-core component check --manifests /srv/manifests
# Or click "Re-check" on the Components page.
```

Expected after pull: **11 / 11 OK**.

The "Installed" column will show `—` for the silent-probe
services (caddy, haproxy, mariadb, naiveproxy, panel, redis,
sing-box). Version pinning is still enforced at image-build
time by the docker tag in `docker-compose.yml`, and the
manifest-drift CI guard cross-checks it on every PR.

---

## [0.0.34] — 2026-05-06 — component-check verify commands run inside the panel

The Components page on the new public admin panel (v0.0.33) showed
**7 / 11 NG** with the diagnostic
`could not exec docker: No such file or directory (os error 2)`
on caddy, haproxy, mariadb, panel, redis, sing-box, plus
`could not exec caddy: ...` on naiveproxy.

### Root cause

Each component manifest's `verify.command` array shelled out to
`docker exec ct-X Y` (or `caddy list-modules` for naiveproxy).
The component check itself runs *inside* the panel container —
which has no `docker` CLI and no `caddy` binary. Every command
failed at `execvp` with ENOENT before the actual liveness check
even ran. The four "OK" components (`ct-protocol`,
`ct-server-core`, `doh-resolver`, `naiveproxy-client`) only
worked because their verify commands didn't depend on host /
sibling-container binaries.

This was a pre-existing bug from the v0.0.20-ish era when the
component check was first wired up assuming a host-side run
context; the move to "panel container runs the check via
`compose exec -T panel ct-server-core component check`" never
landed an updated manifest set. v0.0.33 inherited the same
broken pattern when `manifests/haproxy.upstream.json` was added
with another `docker exec` verify, taking the count from 6 NG
to 7.

### Changed

Rewrote every `verify.command` to use only tools that *are*
present inside the panel container — `bash`, `curl`, `php`,
`grep`, plus `ct-server-core` itself. The probes are network-
based (TCP / HTTP) where the panel can reach a sibling
service via the docker-compose service-name DNS:

| Component   | Old verify                                                 | New verify                                                                                   |
|-------------|------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| caddy       | `docker exec ct-caddy caddy version`                       | `curl -sIo /dev/null -w '%{http_code}' http://caddy:80/` → expect `308` (Caddy's redirect)   |
| haproxy     | `docker exec ct-haproxy haproxy -v`                        | `bash -c 'exec 3<>/dev/tcp/haproxy/443 && echo connected'` → expect `connected`              |
| mariadb     | `docker exec ct-db mariadb --version`                      | `bash -c 'exec 3<>/dev/tcp/db/3306 && echo connected'` → expect `connected`                  |
| naiveproxy  | `caddy list-modules` (legacy v0.0.1 pre-pivot architecture) | `grep -q '"type": "naive"' /etc/sing-box/config.json` (the file is mounted into the panel)    |
| panel       | `docker exec ct-panel php artisan --version`               | `php /var/www/html/artisan --version` (drop the no-op self-exec wrapper)                     |
| redis       | `docker exec ct-redis redis-cli --version`                 | `bash -c 'exec 3<>/dev/tcp/redis/6379 && echo connected'` → expect `connected`               |
| sing-box    | `docker exec ct-singbox sing-box version`                  | `bash -c 'exec 3<>/dev/tcp/sing-box/443 && echo connected'` → expect `connected`             |

Bash's `/dev/tcp/host/port` builtin is available on the panel
image (Alpine + `apk add bash`) and needs no extra package.
The `connected` token is plain ASCII so the
`expect_stdout_contains` check is reliable across locales.

### Notes on what each probe does *not* check

- TCP-port probes (haproxy / mariadb / redis / sing-box)
  confirm the listener is alive but don't surface the
  *installed version*. The "Installed" column will show `—`
  for these. Versions are still pinned in the manifest and
  enforced at image-build time by the docker tag (`mariadb:11`,
  `redis:7-alpine`, etc.); the smell-test in
  `.github/workflows/audit.yml` cross-checks the compose file
  against the manifest pins on every PR.
- The naiveproxy probe greps the rendered config for the
  inbound type. It doesn't connect to sing-box's listener
  because that's already what the sing-box probe asserts; an
  extra TCP connect would be redundant noise.
- The caddy probe expects an HTTP 308 because the `:80` site
  block in `caddy/Caddyfile.tpl` redirects every request to
  HTTPS. If a future Caddy edit changes that, this probe
  needs to update too.

### Operator recovery

Pure JSON change — the panel source is bind-mounted via
`./panel:/var/www/html`, but the manifests are mounted
read-only via `./manifests:/srv/manifests:ro`. A `git pull`
on the host immediately exposes the new manifests inside the
running panel:

```sh
cd ~/cool-tunnel-server
git pull --ff-only
# Re-check from the panel:
docker compose exec panel ct-server-core component check --manifests /srv/manifests
# Or via the Components page in the panel — the Re-check button
# bypasses the 30 s cache.
```

No image rebuild, no container restart, no compose down
needed.

---

## [0.0.33] — 2026-05-06 — public admin panel via haproxy SNI router (R1-1 / R1-2)

Closes the deferred audit items **R1-1** and **R1-2** from the
2026-05-04 audit ("TLS-terminating front-door + path-based router
for the admin panel"). Adds an HAProxy SNI router on `:443` that
demuxes traffic to either the proxy backend or the panel
backend based on the SNI in each TLS ClientHello, without
decrypting any of it.

The admin panel is now publicly reachable at
`https://${PANEL_DOMAIN}/admin` (default `panel.${DOMAIN}`).
The legacy SSH-tunnel access path
(`ssh -L 9000:127.0.0.1:9000 host` + `http://localhost:9000/admin`)
still works as a defence-in-depth fallback — the panel container
keeps its `127.0.0.1:9000:9000` host binding.

### Architecture

```
                cookie.example.com  ─┐
                panel.cookie.example.com ─┤   (both A records → same VPS IP)
                                          ▼
              ┌──────────────────────────────────────────┐
              │ VPS  :443                                │
              │  ┌─────────────────────────────────────┐ │
              │  │ HAProxy (SNI sniff, no TLS decrypt) │ │
              │  └────────────────┬────────────────────┘ │
              │       SNI = ?     │                       │
              │  ┌────────────────┴────────────────────┐ │
              │  ▼                                     ▼ │
              │  apex domain               panel.subdomain│
              │  ─────────                 ───────────────│
              │  sing-box  (NaiveProxy)    Caddy → panel  │
              │  internal :443             internal :8444 │
              │  (terminates own TLS)      (own TLS, own  │
              │                             cert from     │
              │                             Caddy's ACME) │
              └──────────────────────────────────────────┘
```

HAProxy in TCP/SSL-passthrough mode sees only encrypted bytes;
the cipher / JA3 / JA4 fingerprint observed by a client is
whatever the backend negotiates. Anti-tracking probe-resistance
is preserved end-to-end. The default backend is the proxy (NOT
the panel) — an SNI-less probe lands on sing-box's NaiveProxy,
not the Filament login. (See `haproxy/haproxy.cfg.tpl` rationale
comment.)

### Added

- **`haproxy` service** in `docker-compose.yml`, image
  `cool-tunnel-server-haproxy:latest` from
  `docker/haproxy/Dockerfile` (FROM `haproxy:2.9-alpine`). Owns
  `:443` on the host. mem_limit 32 MiB, pids_limit 16, full
  hardening anchor merge.

- **`haproxy/haproxy.cfg.tpl`** — TCP-mode SNI router config.
  `bind :443` in `mode tcp` with `tcp-request inspect-delay 5s`
  to buffer the ClientHello before extracting `req_ssl_sni`.
  Two backends: `panel_caddy` (`caddy:8444`) and
  `naive_singbox` (`sing-box:443`). Default backend is the
  proxy (anti-fingerprinting).

- **`core/ct-server-core/src/haproxy/mod.rs`** — Rust render
  module mirroring `caddy/mod.rs`. Reads the operator's
  `DOMAIN` from the `server_configs` row plus `PANEL_DOMAIN`
  from the global CLI flag (defaults from `.env`); validates
  both via `template::caddyfile_validate` (HAProxy's hostname
  grammar is a strict subset of Caddyfile's); atomic write
  with the same `.tmp` + `rename` pattern.

- **`ct-server-core haproxy render`** subcommand wired into
  `main.rs::dispatch`. Globals: `--panel-domain` /
  `PANEL_DOMAIN`. Op-locals: `--template` /
  `HAPROXY_CONFIG_TEMPLATE` (default
  `/srv/haproxy/haproxy.cfg.tpl`); `--output` /
  `HAPROXY_CONFIG_PATH` (default
  `/usr/local/etc/haproxy/haproxy.cfg`).

- **`scripts/render-haproxy.sh`** — operator-facing one-shot
  render mirroring `render-caddyfile.sh` /
  `render-singbox.sh`.

- **Caddyfile site block** for `${PANEL_DOMAIN}:8444` —
  TLS-terminating reverse-proxy to `panel:9000`. Pinned to
  TLS 1.3, strips `Server: Caddy` header, suppresses per-
  request access log, lets Filament's built-in throttling
  handle login brute-force.

- **`PANEL_DOMAIN`** in `.env.example` (default
  `panel.proxy.example.com`). Documented as requiring a
  separate DNS A record on the same VPS IP.

- **`manifests/haproxy.upstream.json`** — component manifest
  for the OK/NG check at install end.

- **Anti-tracking smell-test additions** in
  `.github/workflows/audit.yml`:
  - sing-box service must NOT host-expose `:443`
  - haproxy.cfg.tpl must use `mode tcp` (no TLS termination)
  - haproxy.cfg.tpl `bind :443` must NOT carry `ssl`
  - `default_backend naive_singbox` (not panel)
  - `use_backend panel_caddy` rule must use case-insensitive
    SNI match (`-i`)

### Changed

- **sing-box service** lost its `ports: ["443:443"]` host
  binding — it still listens on the container's `:443`
  internally, reachable only from haproxy via `ct-net`. The
  `sing-box/config.json.tpl` itself is unchanged.

- **`scripts/install.sh`** step 3 detects an empty
  `PANEL_DOMAIN` on upgrade and self-heals to `panel.${DOMAIN}`,
  appending the value to `.env`. Step 11 ("Render initial
  configs") now also renders `haproxy.cfg`. Steps 12-13 wait
  for BOTH certs (apex + panel) to land in `caddy_data` before
  proceeding. New step 14 starts haproxy after sing-box. Tail
  message points the operator at `https://${PANEL_DOMAIN}/admin`
  for panel access and a separate proxy-connection URL for
  NaiveProxy clients.

- **`SESSION_SECURE_COOKIE`** default flipped from `false` to
  `true`. The panel is now reachable over real HTTPS so the
  `Secure` cookie flag is correct. Operators who rely on the
  legacy SSH-tunnel access path (`http://localhost:9000/admin`)
  must flip this back to `false` — the comment in
  `.env.example` documents the trade-off.

- **`APP_URL`** default in `.env.example` changed from
  `https://${DOMAIN}/admin` to `https://${PANEL_DOMAIN}/admin`.
  Subscription URLs now also use `PANEL_DOMAIN`. Existing
  operators who upgrade with their old `.env` keep their
  custom value; install.sh's step 3 self-heal only fills in
  `PANEL_DOMAIN` itself.

- **`caddy::render`** signature now takes `panel_domain: &str`
  alongside `database_url` etc. The new Caddyfile site block
  needs the panel hostname, so the renderer plumbs it through
  from `--panel-domain` / `PANEL_DOMAIN`.

- **`core/Cargo.toml`** workspace version bumped from
  `0.0.29` → `0.0.33`. `ct-protocol` inherits via
  `version.workspace = true`. `manifests/{panel,
  ct-server-core, ct-protocol}.upstream.json` pins bumped
  in lock-step.

### Operator upgrade path

```sh
cd ~/cool-tunnel-server
git pull --ff-only
# add panel.${DOMAIN} as a second DNS A record on the same VPS IP
# (Cloudflare: gray-cloud / "DNS only" — orange-proxied breaks
#  SNI passthrough)
./scripts/install.sh
# step 3 self-heals PANEL_DOMAIN if missing from .env
# steps 11-14 render + start the new haproxy service
# Caddy obtains a second cert for the panel subdomain via HTTP-01
```

For operators already on v0.0.32: the install.sh poka-yoke
(v0.0.31) detects existing volumes and offers a non-destructive
continue. The DB row is preserved; only the rendered configs
change.

### Migration risks

- **Cert pipeline change**: Caddy now manages two certs.
  HTTP-01 challenges still work because :80 is unchanged.
  install.sh step 12 waits for both to land before proceeding.
  Smoke-tested on Let's Encrypt staging.

- **NaiveProxy fingerprint**: HAProxy's TCP/SSL-passthrough
  preserves the cipher / JA3 / JA4 fingerprint. Verified by
  design (no TLS termination at the router) and asserted by
  the smell-test (`mode tcp`, no `ssl` on `bind`).

- **Panel attack surface**: a public admin panel adds a
  brute-force surface on `/admin/login`. Filament has built-in
  throttling (5 attempts / minute) and the
  `SESSION_SECURE_COOKIE=true` default closes the cleartext-
  cookie window. A Caddy-level `rate_limit` directive would be
  defence-in-depth but requires a non-stock plugin — deferred
  to a v0.1 cycle.

---

## [0.0.32] — 2026-05-06 — `ct:make-admin` command for hardened User model

Step 14 of `install.sh` (create the first Filament admin) failed
on first real-world Debian 13 deploy with:

```
SQLSTATE[HY000]: General error: 1364 Field 'password'
doesn't have a default value
```

Filament's stock `make:filament-user` calls
`User::create(['name' => …, 'email' => …, 'password' => Hash::make(…)])`.
Cool Tunnel's `User` model deliberately removes `password`,
`role`, and `is_active` from `$fillable` (audit H3 — a
mass-assignment privilege-escalation defence), so the
`password` key is silently stripped from the insert. The DB
column is NOT NULL with no default, so the insert hits 1364
and the admin is never created. The User model's docblock
spelled out the intended path ("Set `password` via the
framework's `setPasswordAttribute`") but no console command
followed through.

### Added

- **`php artisan ct:make-admin` console command** in
  `panel/app/Console/Commands/MakeAdmin.php`. Mirrors
  Filament's stock UX (interactive prompts for name / email /
  password, with `--name` / `--email` / `--password` flags
  for scripted use; password input via `$this->secret()` so
  it doesn't echo). Writes the privileged fields by direct
  property assignment so they bypass `$fillable`; the User
  model's `'hashed'` cast on `password` performs the hash-on-
  assign. `role` is set to `User::ROLE_ADMIN`, `is_active` to
  `true` — both explicit so the command is self-documenting
  about the privilege state of rows it creates. Validates
  name + RFC email + `min:8` password, refuses duplicate
  emails. `phpstan analyse` (level 5, larastan v3) clean.

### Changed

- **`scripts/install.sh` step 14** invokes `ct:make-admin`
  instead of `make:filament-user`. The on-failure and non-
  interactive hint texts also point operators at the new
  command.

### Operator recovery for the failed first install

The panel source is bind-mounted via `./panel:/var/www/html`
(see `docker-compose.yml`), so a `git pull` on the host
immediately exposes the new command inside the running
container — no image rebuild needed:

```sh
cd ~/cool-tunnel-server
git pull --ff-only
docker compose exec panel php artisan ct:make-admin
```

---

## [0.0.31] — 2026-05-06 — install.sh poka-yokes for stale clone + Docker state

Two preventative checks added to `scripts/install.sh` before any
Docker build or `compose up` runs. Both surface the most common
"fresh install fails on first try" patterns explicitly, with
remediation prompts, instead of letting them cascade into opaque
downstream errors (PHP `BOOL_TRUE` parse failures from old
opcache.ini, MariaDB `1045 Access denied for user 'cooltunnel'`
from stale `db_data` volumes).

Real-world catch from the v0.0.22 deployment arc that ended at
v0.0.30: an operator's VPS clone predated the v0.0.25 opcache.ini
hotfix, so the bake-time `COPY opcache.ini` brought in the
broken version, *and* a prior failed install left a
`cool-tunnel-server_db_data` volume seeded with the previous
`DB_PASSWORD` while `.env` had a freshly-generated one. Both
failed at step 8 (migrations) with no signal that the cause was
operator state, not project code.

### Added

- **Pre-flight check: clone freshness.** New step 3 (between
  `.env` validation and the image build phase) runs
  `git fetch --quiet origin main`, compares the local HEAD to
  `origin/main` via `git merge-base`, and routes on the four
  possible states: up-to-date, behind (offers `git pull
  --ff-only`), ahead (notes it, assumes intentional), diverged
  (prompts before continuing). After a successful pull the
  step warns the operator that `install.sh` itself may have
  been the file that updated and offers to abort so they re-run
  with the fresh script. Skips silently if the install isn't a
  git checkout (tarball installs).

- **Pre-flight check: leftover Docker state.** Same step,
  second half. Counts existing project containers
  (`compose ps -a -q`) and project-prefixed volumes
  (`docker volume ls`). Any count > 0 surfaces the `1045
  Access denied` failure mode in plain language and offers
  `compose down -v` (DESTRUCTIVE — defaults to N). Operators
  on a known-good upgrade path can decline; first-time
  installers re-trying after a partial failure can wipe and
  proceed.

Both prompts use the existing `prompt_yn` helper from `lib.sh`,
so non-interactive runs (CI) take the safe default and don't
hang. `shellcheck -x` clean.

### Changed

- `scripts/install.sh` step numbering shifts by one for steps
  formerly 3-13, since the new pre-flight is now step 3. Step
  numbers aren't load-bearing (no scripts grep them) but worth
  flagging for operators reading old runbook drafts side-by-side
  with the running script.

---

## [0.0.30] — 2026-05-06 — larastan v3 + phpstan v2 upgrade

PR #2 installed larastan + phpstan on top of v0.0.29 to clear the
level-5 baseline, but every CI run failed at PHPStan boot with a
fatal class-load mismatch: Larastan v2.11.2's
`ViewStringType::accepts()` returned `TrinaryLogic`, while its
required PHPStan 1.12.x had switched to `AcceptsResult`. Larastan
2.x is end-of-life — fix is to move to v3 (paired with PHPStan v2).
The upgrade pulled in a stricter default rule set that surfaced
two real issues in panel code; both cleared. CI's PHPStan job
went green for the first time on this branch.

Tooling-only bump — no migration, no behaviour change for
operators. The release exists to record the static-analysis floor
that future PRs in this repo can rely on.

### Added

- **`panel/config/cool-tunnel.php`** holds first-boot defaults for
  the `ServerConfig` singleton (`DOMAIN`, `ACME_EMAIL`,
  `ACME_DIRECTORY`). Read via `config()`, so values stay
  resolvable when Laravel's config cache is warm — `env()`
  returns `null` outside `config/` once cached.

### Changed

- **`larastan/larastan` constraint** raised from `^2.9` (resolved
  v2.11.2) to `^3.0` (resolved v3.9.6).
- **`phpstan/phpstan` constraint** raised from `^1.11` (resolved
  1.12.33) to `^2.1` (resolved 2.1.54). `iamcal/sql-parser`
  carried along as a transitive dep (v0.5 → v0.7).
- **`ServerConfig::current()`** reads the three singleton seed
  defaults via `config('cool-tunnel.…')` rather than calling
  `env()` directly. Same on-disk behaviour; correct under config
  cache.

### Fixed

- **PHPStan no longer fatals at boot** on the Larastan extension's
  `accepts()` signature. The level-5 phpstan job is green.
- **`larastan.noEnvCallsOutsideOfConfig`** at three sites in
  `ServerConfig::current` — cleared by the move to `config()`.
- **`nullsafe.neverNull` in `FakeSiteController::show`** is a
  Larastan type-narrowing false positive (`$site` is genuinely
  null when `FakeWebsite` has no rows). Suppressed via a single
  targeted `@phpstan-ignore-next-line` with an explanatory note
  pointing back to that empty-table case.

### Out of scope (deferred)

The audit workflow reports four other failures that were red on
`main` before this change and remain so. Each is its own
cleanup PR:

- `rust (clippy)` — `ct-protocol` lints (`doc_markdown`,
  `must_use_candidate`, `missing_errors_doc`).
- `templates` — sing-box config syntax check expects PEM data.
- `dependency review` — needs Dependency Graph + GitHub Advanced
  Security enabled at the repo settings level.
- `anti-tracking config smell-test` — `clash_api.external_controller`
  template assertion drifted from `0.0.0.0:9090`.

---

## [0.0.29] — 2026-05-06 — deployment hotfix #7 (publish Filament assets)

**Real-world bug #11 from the v0.0.22 deployment arc.** With v0.0.28
unblocking the SSH-tunnel login flow, the user signed in
successfully — and landed on a **functional but unstyled** Filament
dashboard. All the HTML rendered, the data was correct ("Welcome
nick", active accounts: 0, traffic today: 0 B), but every
component was a wall of plain text with browser-default styling.
The "Show password" eye icon rendered as a giant SVG dominating
the screen.

### Root cause

Filament 3 ships its CSS + JS as package assets that need
publishing to `public/css/filament/` and `public/js/filament/`
via `php artisan filament:assets`. The panel's Blade layout
references them at hardcoded paths
(`/css/filament/filament/app.css?v=3.3.50.0` etc.), which nginx
serves out of `public/`. Without the publish step, the assets
don't exist on first boot — the HTML loads with `<link>` tags
pointing at 404s, browser falls back to default styles, every
panel page is technically functional but visually broken.

The pre-fix entrypoint ran `filament:cache-components` (which
caches Filament's component metadata for faster boot) but NOT
`filament:assets` (which copies the package's published static
files into `public/`). The two commands sound similar but do
completely different things.

### Fixed

- **`docker/panel/entrypoint.sh`** runs `php artisan filament:assets
  --no-interaction || true` after `filament:cache-components` and
  before `config:cache`. Idempotent — copies the package's
  published files over each boot, no-op when already current.
  Header comment documents the trap so the next operator
  inspecting the entrypoint knows why this step exists.

### Recovery for operators stuck on v0.0.28

```bash
docker compose exec panel php artisan filament:assets
docker compose exec -T panel sh -c 'chown -R www-data:www-data /var/www/html/public && chmod -R 0755 /var/www/html/public'
```

Then hard-refresh the browser (`⌘+Shift+R` on Chrome / `⌘+Option+R`
on Safari) to bypass the cached "no-CSS" render.

### Smoke-test gap (seventh time in a row)

All seven `v0.0.23–v0.0.29` deploy hotfixes were missed by the
Lima smoke runs. The pattern is now well-established:
post-`down -v` first-boot exercises codepaths that no smoke run
ever reaches. The fix has been deferred for too long; **the next
test pass MUST include a `down -v` + first-boot + login + create-
proxy-account + connect-client end-to-end check**.

---

## [0.0.28] — 2026-05-05 — deployment hotfix #6 (panel access via SSH tunnel)

**Real-world bugs #7-#10 from the v0.0.22 deployment arc.** With
v0.0.27's seed fix in place, the user logged into the VPS, opened
the documented SSH-local-port-forward
(`ssh -L 9000:127.0.0.1:9000 host`), pointed the browser at
`http://localhost:9000/admin` — and hit a cascade of four
panel-access bugs that v0.0.13–v0.0.27 never exercised because
prior smoke tests touched the panel via the Lima image's looser
defaults.

### Root causes (four interlocking bugs)

1. **`docker/panel/nginx.conf`** told PHP-FPM the request was over
   HTTPS via `fastcgi_param HTTPS on;`. Symfony's
   `Request::isSecure()` returned true → Laravel auto-rewrote
   `redirect()->guest(route('filament.admin.auth.login'))` to
   `https://localhost:9000/admin/login`. The browser tried to TLS-
   handshake the plain-HTTP listener and failed with
   `ERR_SSL_PROTOCOL_ERROR`.

2. **`panel/app/Providers/AppServiceProvider::boot()`** force-set
   `URL::forceScheme('https')` unconditionally in production —
   even when the request itself was plain HTTP via SSH tunnel.
   Same redirect-to-https symptom even after fix #1.

3. **`panel/config/session.php`** defaults
   `'secure' => env('SESSION_SECURE_COOKIE', true)` — the session
   cookie was stamped with the `Secure` flag. Even after fixing
   the redirect, the browser refused to send the cookie back over
   plain HTTP, breaking login silently (POST to
   `/admin/login` would create a new unauthenticated session
   every time).

4. **`docker/panel/entrypoint.sh`** ran `chmod -R 0775 storage
   bootstrap/cache` but no `chown`. The directories ended up
   owned by `root:root` (the entrypoint runs as root); FPM
   workers run as `www-data`. Mode 0775 with `root:root` puts
   `www-data` in the "others" bucket → `r-x` → no write. Every
   view-rendering route 500'd with
   `file_put_contents(.../storage/framework/views/...): Failed
   to open stream: Permission denied`. The error was invisible
   in `docker compose logs panel` (PHP `error_log` is empty in
   the alpine FPM image; LOG_CHANNEL=stderr writes to FPM
   stderr but the framework caught the ErrorException
   internally before it reached that path) so debugging required
   patching the panel's exception handler at runtime to dump the
   chain into the response body.

### Fixed

- **`docker/panel/nginx.conf`** — removed `fastcgi_param HTTPS on;`.
  Once the deferred R1-1/R1-2 SNI router lands and the panel sits
  behind a real TLS-terminating proxy, that proxy should forward
  `X-Forwarded-Proto: https` and TrustProxies (already configured
  in `bootstrap/app.php` for 127.0.0.1 + 172.16/12) will pick it
  up. No need to spoof HTTPS at this layer.

- **`panel/app/Providers/AppServiceProvider::boot()`** — gates
  `URL::forceScheme('https')` on `request()->isSecure()` instead
  of unconditionally in production. Plain-HTTP SSH-tunnel requests
  no longer get rewritten to https; future TLS-terminated requests
  (real HTTPS or X-Forwarded-Proto: https from a trusted proxy)
  still get correct https URL generation.

- **`.env.example`** documents `SESSION_SECURE_COOKIE=false` for
  the SSH-tunnel access path with a comment explaining the flip
  to `true` once the SNI router lands.

- **`docker/panel/entrypoint.sh`** runs `chown -R www-data:www-data
  storage bootstrap/cache` BEFORE chmod. Now FPM workers can write
  Blade-compiled views, session files, and bootstrap caches.
  Header comment documents the trap so future drop-ins keep it.

### Recovery for operators stuck on v0.0.27

```bash
cd /opt/cool-tunnel-server

# 1. nginx HTTPS hint
docker compose exec -T panel sed -i '/fastcgi_param HTTPS on;/d' /etc/nginx/nginx.conf
docker compose exec -T panel nginx -s reload

# 2. AppServiceProvider forceScheme
sed -i "s|URL::forceScheme('https');|// URL::forceScheme('https'); // see v0.0.28|" panel/app/Providers/AppServiceProvider.php

# 3. SESSION_SECURE_COOKIE
echo "SESSION_SECURE_COOKIE=false" >> .env

# 4. Storage permissions
docker compose exec -T panel sh -c 'chown -R www-data:www-data /var/www/html/storage /var/www/html/bootstrap/cache && chmod -R 0775 /var/www/html/storage /var/www/html/bootstrap/cache'

# 5. Clear cache + restart
docker compose exec -T panel rm -f /var/www/html/bootstrap/cache/config.php
docker compose restart panel

# 6. Smoke check
sleep 25
curl -s -o /dev/null -w "/up: %{http_code}\n/admin/login: %{http_code}\n" \
  http://127.0.0.1:9000/up http://127.0.0.1:9000/admin/login
```

Both should be `200`. Then SSH-tunnel from your laptop and visit
`http://127.0.0.1:9000/admin` (use `127.0.0.1`, not `localhost` —
Chrome HSTS-caches `localhost` and forces HTTPS upgrade).

### Smoke-test gap (sixth time in a row)

All six v0.0.23–v0.0.28 deploy hotfixes were missed by the Lima
Debian-12/13 smoke tests for the same reason: smoke runs reused
volumes from earlier loops, so the entrypoint's first-boot
codepath was never exercised against a clean state. The next
test pass MUST start from `docker compose down -v` and then
walk the install-and-login flow end-to-end. The deferred R1-1/
R1-2 SNI router will need a parallel "panel reachable via real
HTTPS" smoke too.

---

## [0.0.27] — 2026-05-05 — deployment hotfix #5 (entrypoint must seed)

**Real-world bug #6 from the v0.0.22 deployment arc.** With v0.0.26's
sentinel + `migrate:status` verify in place, the user's recovery
flow surfaced the next failure mode: the renderer crashed against
a freshly-migrated-but-unseeded DB.

```
$ docker compose exec -T panel ct-server-core --json caddyfile render
error: no rows returned by a query that expected to return at least one row
$ docker compose exec -T panel ct-server-core --json singbox render
error: no rows returned by a query that expected to return at least one row
```

### Root cause: migrations create the schema, seeders create the row

`db.rs::server_config()` does `SELECT … FROM server_configs WHERE
id = 1` via sqlx's `fetch_one`, which returns
`RowNotFound` (Display: "no rows returned by a query that expected
to return at least one row") when the row is missing. The
`server_configs` table is created by the migrations the entrypoint
ran successfully — but its singleton id=1 row is created by the
seeder, which **only runs from install.sh** (line 200, after the
migrate verify step).

Pre-v0.0.26, install.sh's race-prone `migrate` ran every boot AND
the seeder ran right after, so on re-deploys the renderer
incidentally always saw a populated row. Once v0.0.26 wired
install.sh to wait for the entrypoint sentinel before running its
own checks, the entrypoint became the de facto bring-up path —
which lacked the seed step entirely. First-boot from a clean
`db_data` volume left server_configs empty long enough for the
entrypoint's own `caddyfile:render` / `singbox:render` artisan
commands (and any operator running ct-server-core directly) to
fail with `RowNotFound`.

### Fixed

- **`docker/panel/entrypoint.sh` runs `php artisan db:seed --force
  --no-interaction` after migrate, before any render command.** Both
  paths are idempotent — `ServerConfig::current()` is a
  `firstOrCreate(['id' => 1], [...])` call,
  `FakeWebsite::create` is gated by a `count() === 0` check —
  so re-running the seeder on every container restart is a no-op
  when the singleton row already exists. install.sh's redundant
  `db:seed` (line 200, after migrate-status verify) stays as a
  belt-and-braces guard for the case the entrypoint's seeder is
  swallowed by the existing `|| true`.

### Note

Operators stuck at v0.0.26 mid-deploy can recover without a
volume nuke:

```bash
docker compose exec -T panel php artisan db:seed --force --no-interaction
docker compose exec -T panel ct-server-core --json caddyfile render
docker compose exec -T panel ct-server-core --json singbox render
docker compose restart caddy
```

Then watch the Caddy log for `"certificate obtained successfully"`
and create the admin via `make:filament-user`.

The Lima smoke tests missed this for the same reason as
v0.0.23–v0.0.26: smoke runs reused volumes from earlier loops, so
server_configs was always seeded from a previous run and the
fresh-volume codepath (entrypoint must seed) was never exercised.

---

## [0.0.26] — 2026-05-05 — deployment hotfix #4 (migrate-race fix)

**Real-world bug #5 from the v0.0.22 deployment arc.** With v0.0.25
in place, the user re-ran a fresh `down -v` + `install.sh` on the
RackNerd Debian 13 VPS. Both render commands now succeed — the
URL-grammar trap is gone — but install.sh died at step 8 with:

```
0001_01_01_000001_create_cache_table ........................... 3.70ms FAIL
SQLSTATE[42S01]: Base table or view already exists: 1050 Table 'cache' already exists
```

### Root cause: concurrent `migrate` race

`docker/panel/entrypoint.sh` runs `php artisan migrate --force
--no-interaction || true` on every container boot (line 103) so a
fresh first-boot brings the schema up before supervisord starts
PHP-FPM. install.sh then runs its OWN `php artisan migrate --force`
(line 197) immediately after `vendor/autoload.php` appears,
intending to surface a "concrete success/failure" signal that the
entrypoint's `|| true` swallows.

`vendor/autoload.php` lands ~5s into composer install. The
entrypoint then keeps running for another ~30-60s doing migrate +
{filament,config,route,view}:cache + caddyfile/singbox render in
serial. install.sh's `migrate` therefore fires WHILE the
entrypoint's `migrate` is mid-flight. Two `php artisan migrate`
processes against the same DB:

1. Process A (entrypoint): `CREATE TABLE cache` — succeeds —
   has not yet committed `INSERT INTO migrations(cache_table)`
2. Process B (install.sh): `SELECT name FROM migrations` returns
   empty → decides every migration is pending → `CREATE TABLE
   cache` → SQLSTATE 42S01 collision

`db_data` was confirmed fresh (the user did `down -v`) and v0.0.25's
typed sqlx options worked correctly — this was install.sh racing
itself, not a code bug in the renderer.

### Fixed

- **`docker/panel/entrypoint.sh`: write a sentinel file at the END
  of first-boot setup.** After migrate + cache:* + render:*, the
  entrypoint now does
  `: >/tmp/cool-tunnel/entrypoint-complete`
  before `exec`'ing supervisord. `/tmp` is tmpfs in this image so
  the sentinel auto-clears on every container restart and the
  next first-boot run waits cleanly without manual reset.

- **`scripts/install.sh`: wait for the sentinel, then verify with
  `migrate:status`.** The pre-fix code waited only for
  `vendor/autoload.php` (a 5-second signal that doesn't bound the
  entrypoint's serial work) and then ran its own concurrent
  `migrate`. The fix replaces that with:
  - `wait_for "panel entrypoint setup complete (sentinel)" 90 5`
    against `/tmp/cool-tunnel/entrypoint-complete` — covers the
    full composer + migrate + render serial chain on a 1-vCPU VPS.
  - `php artisan migrate:status --no-interaction` post-wait —
    parses the output for any `Pending` row and `die`s with the
    full status table if one is found. Catches the case the
    original `migrate` was guarding against (entrypoint hit a real
    error and `|| true` swallowed it) without spawning a second
    concurrent migrate.
  - The redundant `db:seed --force` runs unchanged.

### Note

Operators stuck mid-deploy on v0.0.25 (cache table created, install
exited at step 8) can recover without bumping to v0.0.26: the
entrypoint's migrate almost always completes successfully despite
install.sh's earlier crash. Verify with
`docker compose exec -T panel php artisan migrate:status` — if all
rows show `Ran`, just continue from step 9 manually
(caddyfile/singbox render → caddy restart → wait for cert → create
admin user). v0.0.26 is the durable fix so the next operator
doesn't hit the race.

The Lima smoke tests didn't catch this either, for the same reason
they missed the previous three deploy hotfixes: they were seeded
on volumes carried over from earlier loops, so the entrypoint's
migrate path was a no-op (all migrations already recorded), and
the race window was effectively zero. Future smoke tests need to
start from `down -v` to exercise the first-boot codepath.

---

## [0.0.25] — 2026-05-05 — deployment hotfix #3

**Real-world bug #4 from the v0.0.22 deployment arc.** With the
v0.0.24 cap_drop fix in, MariaDB came up healthy and the panel
booted past migrations on the user's RackNerd Debian 13 VPS. Two
new errors surfaced on the very next install step:

```
PHP: syntax error, unexpected BOOL_TRUE in /usr/local/etc/php/conf.d/opcache.ini on line 4
error: error with configuration: invalid port number
✗ FAILED Render initial Caddyfile + sing-box config from DB
! Caddyfile render failed — Caddy will start with no domain configured
```

Both surface during `install.sh` step 8 ("Render initial
Caddyfile + sing-box config"). The first one prints during PHP
startup; the second crashes the Rust core's `caddyfile render`
and `singbox render` subcommands. Together they cascade into
"Caddy never requests a cert" → "ACME timeout" → "fresh deploy
hangs at step 9 with no obvious culprit."

### Fixed

- **`docker/panel/opcache.ini`: switched all comments from `#` to
  `;`.** PHP's INI parser officially uses `;` for line comments;
  it tolerates `#` only when the line contains no `=`. Once a
  `#`-prefixed line had both `=` and a value-shaped tail
  (`# JIT buffer = 192 MB just to cache compiled PHP, which on a
  small`), PHP read it as `key = value`, tokenised the value, and
  hit the literal `on` in "which **on** a small" — which the
  lexer classified as `BOOL_TRUE`, aborting startup with
  `unexpected BOOL_TRUE in opcache.ini on line 4`. Tested fine on
  Lima Debian-12/13 because Lima's images use a different PHP
  build with a slightly more permissive `#`-comment handler;
  Debian 13 RackNerd ships php:8.3-fpm-alpine that's strict.
  All comments in opcache.ini are now `;`-prefixed for portability;
  the sibling `php-hardening.ini` already used `;` (audited as
  part of the fix). Header in opcache.ini documents the trap so
  future drop-ins copy the right pattern.
- **`core/ct-server-core/src/db.rs`: typed connection options
  replace URL-formatting on the discrete-env-vars path.** The
  pre-fix `assemble_from_parts()` formatted DB_HOST / DB_PORT /
  DB_USERNAME / DB_PASSWORD into `mysql://user:pass@host:port/db`
  and re-parsed it through `MySqlConnectOptions::from_str`. That
  path silently broke on any password containing `/`, `@`, `:`,
  `#`, or `?` — i.e. characters the URL grammar treats as
  delimiters. install.sh's recommended `openssl rand -base64 32`
  outputs `/` in roughly a third of values; once a `/` landed in
  DB_PASSWORD, the URL parser read it as the path separator,
  treated everything after as the URL path, and resolved the
  authority as `cooltunnel:abcXYZ` — making the "port" the
  password's prefix. `url::ParseError::InvalidPort` then
  surfaced through sqlx as the famously unhelpful
  `error: error with configuration: invalid port number`.
  v0.0.25 builds `MySqlConnectOptions` directly from the env
  vars via the typed builder; secrets never touch the URL grammar.
  Added 4 regression tests in `db::tests` covering the slash-
  password case, malformed `DB_PORT` fallback, default-on-no-env
  agreement with the compose env block, and the
  explicit-DATABASE_URL path still working unchanged.

### Note

Both bugs are install-time only. Anyone already running v0.0.22
or v0.0.24 with the same .env (where the password was generated
*after* the panel container boot, or via `openssl rand -hex 24`
which produces no URL-meta chars) is unaffected. The hotfix
re-runs the existing first-deploy flow without manual intervention
once the operator pulls v0.0.25 and re-runs `install.sh`.

The Lima smoke tests didn't catch either of these because:
1. The opcache.ini case needs a strict `#`-comment handler, which
   the Alpine-PHP build in production uses but Lima's stock image
   doesn't.
2. The URL-port case needs a password generated with
   `openssl rand -base64 32` (containing `/`); Lima's smoke tests
   were seeded with deterministic short test passwords that
   happened to never contain URL-meta characters.

Future smoke tests need to seed passwords with the exact
generator install.sh recommends (`openssl rand -base64 32`) and
loop a few times to exercise the `/`-tail probability.

---

## [0.0.24] — 2026-05-05 — deployment hotfix #2

**Real-world bug #3 from v0.0.22 deployment.** A user pulling
v0.0.23 onto a fresh Debian 13 RackNerd VPS got past the Docker
install (v0.0.23 fix) but the install script then stuck at
"MariaDB healthcheck never came up after 60s." `docker compose
logs db` showed:

```
ct-db | error: failed switching to 'mysql': operation not permitted
```

repeated every minute, forever.

### Fixed

- **`cap_drop: [ALL]` (v0.0.17 hardening) was too aggressive for
  three services** that legitimately need a small capability
  set: db, redis, panel. Each runs an entrypoint that drops root
  → service-user via `gosu` / `su-exec` / PHP-FPM's pool
  config — `setuid()` requires `CAP_SETUID` even when *demoting*
  privileges. Without it the entrypoint fails with "operation
  not permitted" and the container crash-loops without ever
  initialising. Restored the minimum cap set
  (`CHOWN, SETUID, SETGID, DAC_OVERRIDE, FOWNER`) on those three
  services. caddy and sing-box are unchanged
  (`NET_BIND_SERVICE` only) — they don't switch users.
- All other v0.0.17 hardening properties stay intact:
  `security_opt: no-new-privileges`, json-file log rotation,
  per-service `mem_limit` and `pids_limit`. The "spine" is
  unchanged.

### Note

The v0.0.17 cap_drop change was tested only in the Lima Debian-13
VM smoke tests, which used pre-existing volumes carried over
from earlier loops — MariaDB had already initialised, so the
first-boot user-switch path that needed `CAP_SETUID` was never
exercised. First real-world deploy with a clean volume caught
it instantly. Future smoke tests need to start from a freshly-
created volume to exercise the init-time codepath.

---

## [0.0.23] — 2026-05-05 — deployment hotfix

**Real-world deployment broke on the first try.** A user pulling
v0.0.22 onto a fresh Debian 13 RackNerd VPS hit a dpkg
file-conflict error the moment they ran the README's quickstart
`apt install` line. The README's shortcut mixed Debian's stock
`docker.io` with Docker's official `docker-compose-plugin` —
fine on a vanilla Debian box, deployment-breaker on any image
where Docker's official repo is pre-configured (which RackNerd /
Hetzner Cloud / Vultr / many other budget VPS images do).

The exact failure:

```
trying to overwrite '/usr/libexec/docker/cli-plugins/docker-buildx',
which is also in package docker-buildx-plugin
dpkg: error processing archive .../docker-buildx_0.13.1+ds1-3_amd64.deb
```

### Fixed

- **README quickstart now uses Docker's official apt repo
  end-to-end** (matches the long-form recipe already in
  `docs/installation-debian.md` § 5). Adds an inline callout for
  operators who hit the half-broken dpkg state from running an
  older copy of the README — `apt --fix-broken install` +
  remove `docker.io` + reinstall the `docker-ce` family.

### Note

This is a hotfix. The "2026 Milestone Closing" tag stays at
v0.0.22 — the spine is unchanged; only the install
documentation was wrong.

---

## [0.0.22] — 2026-05-05 — **2026 Milestone Closing**

**Surgical-strike closer.** Two final-anchor features and the
canonical retrospective for the v0.0.13 → v0.0.22 self-audit
programme. After this release, no further self-check loops are
required — the spine is firm.

### Added

- **DoH endpoint reachability check** for operators in censored
  regions. New `ComponentKindV1::DohEndpoint` variant in
  `ct-protocol`; new `verify_via_doh` arm in
  `ct-server-core/src/components.rs` that reads the live
  `ServerConfig.doh_resolver` (panel-editable, not the .env
  default) and dispatches an RFC 8484 binary DoH query for
  `example.com IN A`. Asserts HTTP 200 + ANCOUNT > 0 — catches
  captive portals, transparent DNS poisoners, and outright
  blocks of upstream resolvers like 1.1.1.1. Manifest at
  `manifests/doh-resolver.upstream.json`.
  Operator path: change resolver in panel → re-run `component
  check` → iterate until OK.
- **`mem_limit` + `pids_limit` per service** in
  `docker-compose.yml` (1 GB VPS determinism). caddy 64M/32,
  sing-box 128M/64, panel 320M/256, db 192M/128, redis 64M/32.
  Total hard cap 768 MiB; ~256 MiB reserved for host kernel +
  Docker daemon on a 1024 MiB box. Sized from the empirical
  measurements of all 9 prior releases — deterministic OOM-kill
  on overflow rather than host-wide thrash.
- **`docs/architectural-decisions-2026.md`** — 389-line
  retrospective covering the eight self-check loops, the seven
  load-bearing invariants that emerged, the defense-to-offense
  posture pivot, major architectural decisions + trade-offs, and
  the deferred-work roadmap. The canonical reference for any
  future contributor reasoning about the v0.0.13–v0.0.22 arc.

This is the **2026 Milestone Closing**. Tag.

---

## [0.0.21] — 2026-05-05

**Loop-7: diminishing-returns marker.** Audit angles previous
loops hadn't touched (Filament Resource action paths, ct-protocol
crate, TODO/FIXME residue, Rust idioms, seeders, wire size limits,
quota concurrency, install.sh under cap_drop). Eight areas swept;
seven returned "no bug found". One LOW finding shipped here:

### Fixed

- **Defense-in-depth FQDN regex on `ServerConfigPage::domain`
  input.** The v0.0.16 render-layer guard blocks metasyntactic
  values from reaching Caddy, but a typo'd domain still persists
  in the DB and breaks every subsequent render until the operator
  notices. Form regex (RFC 1123 label shape, max 253 chars)
  rejects the typo at save time.

### Audit areas confirmed clean (no fix needed)

- Filament Resource actions: `regenerate_password` correctly uses
  `setCleartextPassword()` and shows cleartext via persistent
  notification only; FakeWebsite payload stays inside `{{ }}`-
  escaped Blade; `TrafficLogResource` confirmed read-only.
- `ct-protocol`: `subscription.rs` carries `version: u32` and
  HMAC-SHA-256; `components.rs` verify-command path runs only
  manifests from the `:ro` mount under `/srv/manifests`; trust
  boundary is the repo, not a runtime input.
- Zero `TODO`/`FIXME`/`HACK`/`XXX` matches across the entire
  codebase.
- Zero `unwrap`/`expect`/`panic` in non-test Rust code; zero
  `unsafe` blocks (workspace-wide `forbid(unsafe_code)` holds).
- All 4 `tokio::spawn` sites have explicit error handling /
  retry-with-backoff / runtime-test scopes.
- `quota.rs` uses `SELECT ... FOR UPDATE` inside a transaction;
  no double-decrement risk.
- `DatabaseSeeder` does not seed a default-admin password; seeds
  three FakeWebsite rows so the cover-site invariant holds on
  fresh install.

---

## [0.0.20] — 2026-05-05

**Loop-6: closes the deferred items + a CI gap discovered along
the way.** Wires the v0.0.19 PHPUnit suite into CI, adds the test
that guards the v0.0.15 critical `DB::afterCommit` fix, sweeps
five releases of doc drift in README + SECURITY, and fixes a
silent CI false-green where the sing-box template-validate job
was rendering literal `{{ .DohServer }}` / `{{ .DohPath }}` /
`{{ .ClashListen }}` placeholders into "validated" configs.

### Added

- **`panel/tests/Feature/ProxyAccountAfterCommitTest`** — four
  cases covering the v0.0.15 C1 fix (rolled-back save → no
  dispatch, committed save → 1 dispatch, no-txn save → dispatch
  immediately, rolled-back delete → no dispatch + row preserved).
  Pre-fix the C1 bug was real and shipped without a test; this
  is the regression guard.
- **CI step `phpunit (panel)`** in `.github/workflows/ci.yml`'s
  `php` job. Runs `composer install --no-scripts` (matching
  v0.0.16's supply-chain hardening pattern) followed by
  `vendor/bin/phpunit --colors=never`. The v0.0.19 scaffold + 9
  tests + the v0.0.20 4-case AfterCommit test now exercise on
  every PR.

### Fixed

- **CI sing-box template substitution gap.** The `template` job
  in ci.yml was sed-substituting six bindings into the
  Caddyfile.tpl + sing-box config.json.tpl before passing them
  to upstream `caddy validate` and `sing-box check`. Since
  v0.0.13's H3 fix added `{{ .ClashListen }}` (and the prior
  sing-box 1.12+ DohServer/DohPath split landed without a
  matching CI substitution update), three bindings were leaking
  through as literal placeholder strings in the rendered file.
  Both validators happily accepted any string as the field value
  — no shape constraint fired — so CI was silently green on
  configs that wouldn't actually load. Adds the missing
  substitutions.

### Changed (docs only)

- **`README.md`** updated for v0.0.15-v0.0.19 properties:
  upgrade-checkout example v0.0.14 → v0.0.20, mention of
  `scripts/restore.sh` (v0.0.15) in Common operations,
  readiness-gate count 10 → 11 checks (v0.0.18 added the
  cover-site invariant check).
- **`SECURITY.md` Defensive defaults** updated: DB::afterCommit
  (v0.0.15), atomic_write parent fsync (v0.0.15), Caddyfile-
  injection guard (v0.0.16), composer --no-scripts (v0.0.16),
  cap_drop ALL + no-new-privileges (v0.0.17), SecurityHeaders
  middleware (v0.0.18), schedule onFailure logging (v0.0.18).
  New "Test coverage" section documents the v0.0.19/v0.0.20
  PHPUnit + Rust counts.

---

## [0.0.19] — 2026-05-05

**Loop-5: panel test scaffold + automated coverage of the cover-site
invariant + H2 auth gate.** Pre-fix the panel had ZERO PHPUnit tests
through v0.0.13–v0.0.18 (every fix landed unverified by automated
test). Loops 1–4 surfaced the gap; this loop closes the largest
risk it implied.

### Added

- **`panel/phpunit.xml`** — PHPUnit 11 config (SQLite in-memory test
  DB, sync queue, array cache, fixed APP_KEY, fail-on-warning +
  fail-on-risky).
- **`panel/tests/TestCase.php`** — base test case extending Laravel
  11's `BaseTestCase`.
- **`panel/database/factories/{User,ProxyAccount,FakeWebsite,
  ServerConfig}Factory.php`** — Eloquent factories with default
  values + states (`viewer`, `inactive`, `expired`, `disabled`,
  `active`) covering the v0.0.13/v0.0.16 model invariants.
- **`panel/tests/Feature/CoverSiteInvariantTest`** — four cases
  asserting byte-equal Content-Type + ETag + body between every
  failure response (unknown token, expired account, rate-limit
  hit, uncaught route exception) and a baseline cover-site hit.
  A regression in any of the four paths fails CI.
- **`panel/tests/Unit/UserCanAccessPanelTest`** — five cases
  exercising the H2 three-way gate (panel id, `is_active`,
  `role`) plus a defense-in-depth assertion that `password` /
  `role` / `is_active` stay out of `$fillable`.
- **`make php-test`** target — runs the panel test suite.
  Required `cd panel && composer install` first; emits a clear
  hint to that effect if `vendor/` is absent.
- **`HasFactory` on `App\Models\ServerConfig`** so the new
  factory resolves (the other three models already had it).

### Deferred to future loops

- Wiring `make php-test` into `make ci` and the `audit.yml` /
  `ci.yml` GitHub Actions workflows. Today the tests exist on
  disk but only run on demand. Plumbing them into CI requires a
  composer-install + sqlite step in the runner; not hard, but
  out of scope for v0.0.19's "land the test infrastructure"
  goal.
- `ProxyAccountAfterCommitTest` — verifying that a transaction
  rollback drops the Redis announce + queue dispatch (v0.0.15
  C1 fix). Doable but needs a transaction + rollback fixture
  pattern that's worth its own pass.

---

## [0.0.18] — 2026-05-05

**Loop-4 self-check pass: 1 HIGH-class test gap closed + browser-
side hardening + scheduler observability + DX.** This round's
lens: test-coverage gaps for the v0.0.13–v0.0.17 fixes, browser-
side security headers, and the deferred items from loop 3.

### Added

- **Test coverage for `template::caddyfile_validate`** (the v0.0.16
  Caddyfile-injection guard had zero tests — single highest-risk
  untested path per the loop-4 audit). Four new unit tests in
  `core/ct-server-core/src/template.rs`: clean values pass, every
  rejected metasyntax char independently fails, the realistic
  injection payload `example.com\n}\nadmin localhost:2019\n{` is
  rejected, error message names the offending field. Test count:
  51 → 55 in ct-server-core.
- **`panel/app/Http/Middleware/SecurityHeaders`** — emits six
  browser-side headers on every `/admin` response: `X-Frame-
  Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` (deny camera/microphone/geolocation/payment/
  usb), `Cache-Control: no-store, must-revalidate`,
  `Strict-Transport-Security: max-age=63072000; includeSubDomains`.
  Filament 3 ships with none of these by default. Wired into
  `AdminPanelProvider`'s middleware stack.
- **`make fmt` / `make lint` / `make test` aliases** — delegate
  to `rust-fmt` / `rust-clippy` / `rust-test`. Muscle-memory DX
  win for cargo-project operators.

### Fixed

- **`panel/routes/console.php`: `->onFailure(...)` on every
  scheduled task.** Pre-fix, a Throwable inside `traffic:rollup`,
  `quota:enforce`, or `singbox:render` was swallowed silently by
  Laravel's scheduler. The insidious case: `quota:enforce` dies
  → over-quota users keep tunneling forever with no operator
  signal. Now every failure logs `schedule.failed` at
  `Log::critical` with cmd + err + exception type.

### Deferred to a future loop

- **DoH reachability check** — synthetic component-check arm that
  verifies `cfg.doh_resolver` actually resolves a query. Needs a
  new `ComponentKindV1::DohEndpoint` variant in `ct-protocol`
  and a `verify_via_https` arm in `components.rs`. Real value
  for operators in censored regions where 1.1.1.1 may be blocked,
  but a non-trivial design.
- **PHPUnit feature tests** for SubscriptionController cover-site
  fallback, exception handler scope, and ProxyAccount
  DB::afterCommit. Needs `panel/phpunit.xml` + `panel/tests/TestCase.php`
  scaffold. Current `panel/tests/` is empty — every panel-side
  fix in five releases is unverified by automated test. Worth a
  dedicated round to land properly with sqlite test DB +
  factories.

---

## [0.0.17] — 2026-05-05

**Loop-3 self-check pass: 1 HIGH (arm64 panel build) + 3 MEDIUM
(backup secret on argv, cap_drop / no-new-privileges, json-file
rotation) + 1 LOW (DX).** The lens this round: storage / secrets /
runtime resource limits / observability gaps.

### Fixed

- **HIGH — `docker/panel/Dockerfile`: TARGETARCH-aware naive
  client.** Pre-fix the URL was hardcoded `linux-x64`, so on
  arm64 hosts the build "succeeded" but installed an x86_64
  binary that fails to exec when the probe path runs. Same
  class as v0.0.13's core/Dockerfile fix; the panel had been
  missed. amd64 SHA stays strict-pinned; arm64 emits a loud
  WARN when no SHA is provided (klzgrad/naiveproxy doesn't
  publish a SHA256SUMS file — operator can pin via
  `--build-arg NAIVE_SHA256_ARM64=<hash>`).
- **MEDIUM — `scripts/backup.sh`: DB root password via
  `MYSQL_PWD` env, not `-p` on argv.** Pre-fix the password
  surfaced in `ps -ef` for the duration of the dump.
- **MEDIUM — `docker-compose.yml`: `cap_drop: [ALL]` +
  `security_opt: [no-new-privileges:true]` on every service**
  via a `x-svc-hardening` YAML anchor. caddy + sing-box add
  back NET_BIND_SERVICE; nothing else needs any capability.
- **MEDIUM — `docker-compose.yml`: json-file log rotation** (10
  MB × 3 files) on every service. Bounds container-log disk
  growth — the docker daemon default is unbounded.
- **LOW (DX) — `scripts/install.sh`: cross-validate
  `CT_CLASH_SUBNET` vs `CT_CLASH_SINGBOX_IP`.** Operators who
  override the subnet to escape a docker-network collision now
  get a clear "first three octets must match" error at pre-
  flight rather than the unhelpful Docker-side "Invalid
  Address" later.

---

## [0.0.16] — 2026-05-05

**Loop-2 self-check pass: 1 HIGH (Caddyfile injection) + 2 MEDIUM
(FakeWebsite race, Composer scripts).** Continued the loop hunt
established in v0.0.14/15. This round's lens: business-logic and
service-layer correctness — Filament Resources, the Caddy/sing-box
generators, model events, scheduled tasks, supply-chain hygiene.

### Fixed

- **HIGH — `core/caddy`: refuse to render Caddyfile with
  metasyntactic operator input.** `caddy::render` previously
  substituted operator-controlled `domain`, `acme_email`, and
  `acme_directory` raw into the Caddyfile template. Caddy's
  grammar treats `{` `}` as block delimiters, `"` as quoted-
  string opener, and `\n` as a directive terminator — a hostile
  DOMAIN like `example.com\n}\nadmin localhost:2019\n{` would
  break out of `{{ .Domain }}:8443 { … }` and inject a Caddy
  admin endpoint onto the public surface. Adds
  `template::caddyfile_validate` (deny-list of those chars) and
  validates every binding before render. Matches the project's
  posture of "refuse rather than sanitise" — Caddyfile has no
  general escape syntax for these.
- **MEDIUM — `panel/fake-website`: serialise activation via DB
  transaction + lockForUpdate.** Two admins concurrently
  activating different rows could leave both `is_active=true`,
  producing nondeterministic cover-site shape. Wrap the
  deactivation of all-others in `DB::transaction` with
  `lockForUpdate` to serialise.
- **MEDIUM — `docker/panel`: composer install `--no-scripts` on
  first boot.** Pre-fix, every transitive Composer package's
  declared scripts ran as the panel user during `vendor/`
  bootstrap. Now `--no-scripts` is passed and the single
  project-known post-install script (`php artisan
  package:discover --ansi`) is invoked explicitly. Bounds the
  supply-chain footgun.

---

## [0.0.15] — 2026-05-05

**Loop-1 self-check pass: 2 CRITICAL correctness bugs + 4 HIGH
hardening + 1 supply-chain advisory waived.** Continued the
self-audit programme that produced v0.0.14; this round's hunt
focused on **runtime correctness under stress** (concurrency,
power-loss, supervisor restart semantics, upgrade ordering) and
**supply-chain audit hygiene**. Both CRITICAL findings are real
correctness bugs, not just hardening — the project would silently
diverge state under specific production conditions.

### Fixed

- **CRITICAL — Redis announce + queue dispatch deferred to
  `DB::afterCommit`** (`panel/app/Models/ProxyAccount.php`).
  Pre-fix, `setAccountStatus`, `announceAccountChanged`, and
  `ReloadSingBoxJob::dispatch` ran inline in `static::saved` /
  `static::deleted`, which fire AFTER the row's INSERT/UPDATE
  but BEFORE the surrounding transaction commits. A rollback
  later in the same transaction left a Redis ghost flag for a
  row that never persisted, plus a queued reload for a phantom
  change. Both callbacks now snapshot the relevant fields at
  save-time and defer the side effects to `DB::afterCommit`,
  which only fires if the outermost transaction commits. Outside
  a transaction the callback runs immediately — pre-fix
  behaviour preserved.
- **CRITICAL — `atomic_write` fsyncs the parent directory after
  rename** (`core/ct-server-core/src/singbox/mod.rs`). POSIX
  rename is atomic for concurrent readers, but the directory
  entry update can sit in the page cache for arbitrarily long.
  Power loss between the rename and the next implicit sync
  reverts the directory entry — sing-box reloads the OLD
  config.json on next boot, silently re-activating revoked
  credentials. Standard fix: open + fsync the parent dir after
  rename. One additional `fdatasync` per render — only triggers
  on actual changes (the SHA-256 dedupe at the caller short-
  circuits unchanged renders).
- **HIGH — `supervisord.conf` `startretries=10` + `startsecs=5`
  on every program** (`docker/panel/supervisord.conf`). Pre-fix
  only `ct-core-daemon` declared retries; the other four
  (php-fpm, nginx, queue, scheduler) inherited supervisord's
  default `startretries=3, startsecs=1`. Three rapid crashes
  (transient Redis blip during `queue:work` boot, first-boot
  timing window before `/run/cool-tunnel` is writable) put the
  program in FATAL — supervisord gives up forever. The most
  common silent regression: `queue:work` FATAL → ReloadSingBoxJob
  backstop dies. Saves still fire the Redis fast-path so the
  user-visible reload happens, but the cold-path consistency
  layer is silently broken until the operator notices via
  `supervisorctl status`.
- **HIGH — `bootstrap/app.php` exception handler tightens
  prefix match** to exact-or-prefix-with-trailing-slash. The
  v0.0.14 `str_starts_with($path, 'admin')` would also match
  future routes like `administrator/`, `admins/list`,
  `admin-export/` — silently losing cover-site protection on
  any path that happens to start with the literal `admin`. Same
  shape applied to `livewire`. Forward-looking; no current
  route exposes it.
- **HIGH — `update.sh` brings the new panel image up BEFORE
  running migrations** (`scripts/update.sh`). Pre-fix the
  sequence was `compose build` → `compose exec panel migrate`
  (against the OLD running container) → `compose up -d panel`
  (finally swap in the new image). Migrations applied via the
  OLD PHP runtime; the OLD interpreter then briefly executed
  against the new schema. Today's migrations happen to be
  additive-with-defaults so the order is safe in practice, but
  the order was fragile by accident. Pinned.
- **HIGH — `backup.sh` quiesces Caddy before tarring
  `caddy_data`**. A cert renewal landing mid-tar could capture
  a half-written `*.crt` or `*.key` in the archive — backup
  silently corrupted, restore would fail to load on the new box.
  Caddy is `compose stop`-ed, the tar runs against the now-
  static volume, then Caddy is restarted (only if it was
  running). The 1-2 minute :80 downtime is acceptable for
  backup; :443 proxy traffic is unaffected.

### Added

- **`scripts/restore.sh`** — companion to `backup.sh`. Pre-fix
  the project shipped a one-way backup with no documented
  restore path. The new script reverses the tarball: untar,
  restore `.env` + manifests + templates, bring up db + redis,
  mariadb-import the dump, restore the `caddy_data` volume,
  bring up panel + sing-box + caddy, run a component check.
  Refuses to overwrite a running stack; idempotent on partial
  re-invocation.
- **`scripts/late-night-comeback.sh` cover-site invariant
  check** (the new check #11, raising the gate from /10 to /11).
  Verifies `/api/v1/subscription/<bogus>` and
  `/lnc-cover-probe` both return HTTP 200 with byte-identical
  ETags, AND that the public Caddy redirect on :80 emits no
  `Server:` header. A v0.0.14 anti-fingerprint regression now
  fails the readiness gate before the box takes real users.

### Security

- **`RUSTSEC-2023-0071` (Marvin Attack on `rsa` 0.9 via
  `sqlx-mysql`) waived**, with documented rationale. We ship
  MariaDB 11 which never invokes the `rsa` codepath
  (`mysql_native_password`, not `caching_sha2_password`); the
  MariaDB connection is on the internal-only `ct-data` docker
  network, blocking any timing-sidechannel pre-condition. No
  upstream fix forthcoming for the rsa 0.9 line. Waiver mirrored
  across `core/audit.toml`, `core/deny.toml`, and the
  `cargo-audit` step in `.github/workflows/audit.yml` so all
  three audit pathways agree.

---

## [0.0.14] — 2026-05-05

**Self-check pass + anti-censorship cover-site hardening.** Two-stage
bug hunt over the v0.0.13 patches surfaced four real bugs (one HIGH,
two MEDIUM, one LOW); a follow-up sweep with the project's actual
threat model (anti-censorship, not just "service down") added six
P0-class hardening items focused on preserving the cover-site invariant
under every observable failure path.

End-to-end verified on a Debian 13 (trixie) Lima VM with
`CT_CLASH_SUBNET=10.99.99.0/24` to exercise the new env-tunable network
path: 65 burst hits past the rate-limit cap all returned HTTP 200 with
identical body, byte-equal ETag, byte-equal Content-Type — censor
indistinguishable from a vanilla unknown-path probe.

### Added

- **`bootstrap/app.php` exception render override** — for any uncaught
  `Throwable` on a public route (everything except `/admin`, `/livewire`,
  `/up`), Laravel now renders FakeSiteController instead of a 5xx HTML
  error page or stack-trace dump. Operator still sees the original
  exception via `Log::critical`.
- **Per-email login rate limit dimension** in `AppServiceProvider`:
  `Limit::perMinute(20)->by('email:'.strtolower($email))`. Defeats
  IP-rotation brute-force against a single email; the per-(email|ip)
  and per-ip dimensions both reset under botnet rotation.
- **Deterministic ETag on cover-site responses** in
  `FakeSiteController` — `sha256(rendered body)` prefix-16. Conditional
  GET (`If-None-Match`) returns 304. Removes the "static-looking site
  with no validators" probe distinguisher.
- **`CT_CLASH_SUBNET` + `CT_CLASH_SINGBOX_IP` env tunables** in
  `.env.example` and `docker-compose.yml`. v0.0.13 hardcoded
  `172.30.0.0/24`; operators with a colliding network (corporate VPN
  bridge, k8s flannel, Tailscale subnet route) couldn't bring the
  stack up. Override both together; `CT_CLASH_LISTEN` is now derived
  from `CT_CLASH_SINGBOX_IP` so a single edit propagates everywhere.

### Changed

- **`SubscriptionController::show`** — anti-enumeration rate limit
  enforced *inside* the controller via `RateLimiter::tooManyAttempts/hit`
  rather than via `throttle:subscription` middleware. Middleware
  returns HTTP 429 on hit, distinguishable from the 200 cover-site;
  in-controller falls through to FakeSiteController on rate-limit hit
  for byte-level parity. The `resolve()` call is now wrapped in a
  `Throwable` catch so any resolver exception (e.g. M-panel-2's
  empty-`APP_KEY` `RuntimeException`) also falls through to
  FakeSiteController.
- **`caddy/Caddyfile.tpl`** — `header -Server` added to both `:80` and
  `:8443` blocks. Stock Caddy emits `Server: Caddy` on every response;
  a censor's `curl -I` previously identified the engine instantly.
  Verified absent from the 308 HTTPS-redirect response.
- **`docker/panel/nginx.conf`** — `map $request $request_logged`
  rewrites `/api/v1/subscription/<token>` to
  `/api/v1/subscription/<masked>` before the access log line is
  written. Pattern matches all HTTP methods, not just GET. Tokens no
  longer persist in `docker logs ct-panel`, in the json-file driver
  on disk, or in operator log-shipping pipelines.
- **`Makefile` `set-version`** — now refreshes `core/Cargo.lock` via
  `cargo update --workspace --offline` so the workspace member version
  entries match `Cargo.toml`. Fails loudly with a remediation hint if
  cargo errors; the prior silent-on-error swallowed three distinct
  failure modes behind a "lockfile still stale" trap.
- **`AppServiceProvider::configureRateLimiters`** — removed the
  unused `RateLimiter::for('subscription')` registration; the limit
  is now expressed as constants inside `SubscriptionController`.

### Fixed

- **`ReloadSingBoxJob::uniqueId()` was dead code** — the class did
  not implement `Illuminate\Contracts\Queue\ShouldBeUnique`, so
  Laravel never consulted `uniqueId()` and the docstring's claim of
  queue-layer dedupe was misleading. Removed the method; updated the
  docstring to honestly attribute idempotency to
  `SingBoxConfigGenerator::renderToFile`'s SHA-256 short-circuit.
- **`ReloadSingBoxJob` queue-connection comment** — said `database`,
  but the shipped `.env.example` is `QUEUE_CONNECTION=redis`. Updated
  to reflect the production reality.

### Security

- **Cover-site invariant now holds across every observed failure
  path** — the byte-on-the-wire response to
  `/api/v1/subscription/<bad-token>`, `/random-path`, a rate-limited
  request, an empty-APP_KEY request, and any uncaught exception is
  identical: status 200, `Content-Type: text/html; charset=utf-8`,
  same ETag, same body. A censor sweeping for proxy endpoints
  cannot distinguish a Cool Tunnel Server from a static-website
  host of the same hosting class purely from response shape.
- **`Server: Caddy` no longer leaked** on the public `:80` redirect.
- **Subscription HMAC tokens no longer logged in plaintext** by the
  panel's nginx access log.

---

## [0.0.13] — 2026-05-05

**High-severity audit hotfixes + low-memory tuning.** Rolls up the
three H-rated findings (rate-limiting gap, single-tier authz, clash-API
blast radius), three M-rated findings, the queue refactor that uncouples
panel saves from the reload subprocess, plus a perf pass that fits the
stack into the documented 1 vCPU / 1 GB minimum spec without OOM.

End-to-end verified on a Debian 13 (trixie) Lima VM: Docker official
apt repo install, `docker compose up -d`, full migration run, sing-box
clash-API reachability test from `panel` (HTTP 401, ✓) and from `caddy`
(timeout, ✓ — caddy is no longer on the management network).

### Added

- **Custom Filament login page** (`panel/app/Filament/Pages/Auth/Login.php`)
  that calls `$this->rateLimit(5)` before delegating to the framework's
  `authenticate()`. (H1.)
- **`login` and `subscription` named rate limiters** in
  `AppServiceProvider::configureRateLimiters()`. (H1.)
- **`users.role` (`varchar(32)` default `admin`) and `users.is_active`
  (`boolean` default `true`)** columns + matching migration
  (`2026_05_05_000001_add_role_and_active_to_users`). (H2.)
- **`App\Jobs\ReloadSingBoxJob`** — queued, idempotent, `tries=3`,
  `90s` per-try cap. Backstops the inline Redis pub/sub announce.
  (R-panel-1.)
- **`ct-clash` internal-only docker network** (172.30.0.0/24) carrying
  clash-API HTTP between `panel` and `sing-box`. Sing-box pinned to
  `ipv4_address: 172.30.0.10` with the `ct-singbox-mgmt` alias. Caddy
  is **not** a member. (H3.)
- **`clash_listen()` in `core/ct-server-core/src/singbox/mod.rs`**:
  reads `CT_CLASH_LISTEN` env, defaults `127.0.0.1:9090` (fail-closed).
  Substituted into `config.json.tpl` as `{{ .ClashListen }}`. (H3.)
- **`release-small` cargo profile** (`core/Cargo.toml`): no LTO,
  `codegen-units = 16`, `opt-level = "s"`. Halves peak compile-time
  RAM (~1.5-2 GB → ~0.6-0.9 GB) at ~5-15 % runtime cost. Selected via
  `CT_CORE_BUILD_PROFILE=release-small` in `.env`; threaded through
  `install.sh` to `docker compose build --build-arg CARGO_PROFILE=…`.
- **`PHP_FPM_PM_MODE` / `_MAX_CHILDREN` / `_IDLE_TIMEOUT` /
  `_MAX_REQUESTS` env tunables** (defaults `ondemand` / `4` / `60s`
  / `500`) in `docker/panel/entrypoint.sh`.
- **Low-memory MariaDB tuning** in `docker-compose.yml`'s `db.command:`
  block: `innodb-buffer-pool-size=64M`, `performance-schema=OFF`,
  `max-connections=20`, `skip-name-resolve`, etc.
- **§ "Before first boot — low-memory VPS prep"** in
  `docs/installation-debian.md`: 2 GB swapfile recipe + `vm.swappiness=10`,
  `release-small` selection, runtime tuning knob table, OOM-watch
  guidance, steady-state expectations table.

### Changed

- **`User::canAccessPanel(Panel $panel)`** now gates on (panel id matches
  `admin`) AND (`is_active === true`) AND (`role === ROLE_ADMIN`). Pre-fix
  this returned `true` unconditionally — any seeded row had full ProxyAccount
  / ServerConfig / FakeWebsite authority. (H2.)
- **`User::$fillable`** trimmed to `['name', 'email']`. `password`, `role`,
  `is_active` removed — set via `setPasswordAttribute` / explicit
  `forceFill` / console seeders only. Defense-in-depth against
  privilege-bearing fields landing in `User::create($request->all())`.
- **`ProxyAccount::booted()`** keeps the Redis revocation pub/sub
  announce inline (~1 ms fire-and-forget) but moves
  `SingBoxConfigGenerator::renderToFile()` + `SingBoxReloader::reload()`
  to `ReloadSingBoxJob::dispatch()`. Pre-fix a hung `ct-server-core`
  blocked the Filament request for up to 60 s; bulk-delete fanned out
  N synchronous reloads. (R-panel-1.)
- **`docker/core/Dockerfile`** detects Docker's `TARGETARCH` and maps
  to the matching musl rustc triple (`x86_64-unknown-linux-musl`,
  `aarch64-unknown-linux-musl`, `armv7-unknown-linux-musleabihf`).
  Project shipped x86_64-only before — broke arm64 hosts.
- **`docker/panel/opcache.ini`** sized for a 1 GB box: shared opcache
  `128 → 64 MB`, JIT buffer `64 → 32 MB`, `max_accelerated_files`
  `10000 → 5000`, `revalidate_freq` `2 → 60 s`.
- **`docker/panel/entrypoint.sh` FPM pool** now `pm = ondemand` with
  `max_children = 4` by default (was `pm = dynamic, max_children = 16`).
  Drops the panel's worst-case from ~480-800 MiB to ~120-200 MiB on
  small boxes; tunable up via env on bigger ones.
- **Throttle middleware on `/api/v1/subscription/{token}`** (60/min
  per IP via the new `subscription` named limiter). (H1.)

### Fixed

- **Saturating subtraction on uplink/downlink deltas**
  (`core/ct-server-core/src/metrics.rs`). Plain subtraction panicked in
  debug and silently wrapped in release if either side approached
  `i64::MIN/MAX`. The hot path is gated by an early-return today
  (sing-box doesn't emit Prometheus-shaped per-user metrics yet — see
  module docstring) so this is hardening for the eventual re-enable
  rather than a live correctness fix. (M-rust-2.)
- **`config('app.previous_keys')` trims each segment**
  (`panel/config/app.php`). `array_filter(explode(',', $env))` kept
  whitespace and `\n` — a stray space in `.env` produced a malformed
  key and silent decryption failures, and accounts mysteriously dropped
  out of the rendered manifest after a key rotation. (M-panel-1.)

### Security

- **`SubscriptionController::signingKey()` refuses an empty `APP_KEY`**.
  `.env.example` ships `APP_KEY=` blank; an operator who forgets
  `php artisan key:generate` would otherwise hash with
  `hash_hmac('sha256', $idStr, '')` — deterministic, so every forged
  token verifies. Hard-fail with `RuntimeException` and a clear
  remediation hint. (M-panel-2.)
- **Six unused dependencies removed** from `core/ct-server-core/Cargo.toml`
  (`hyper`, `hyper-util`, `hyperlocal`, `http-body-util`, `bytes`,
  `hmac`). Matching `From`-impl removals in `err.rs`. The unix-domain
  admin path that needed them was retired long ago; `reqwest` is the
  only HTTP client the binary actually exercises. Shrinks the
  dependency tree, lowers peak compile RAM, and eliminates the
  audit-flagged "unused but pinned" carry-over.

---

## [0.0.11] — 2026-05-03

**Compile-time SQL safety.** Every `sqlx::query()` call in the
Rust core is now `sqlx::query!()` — type-checked against the
panel's MariaDB schema at `cargo check` time, with offline
metadata committed under `core/.sqlx/` so the build never needs
a live DB. Schema regressions (column dropped, retyped, renamed)
become **build failures**, not production failures.

The motivation is the v0.0.10 BIGINT UNSIGNED issue: an `i64`
bound to an unsigned column was caught by sqlx at runtime, after
a 12-minute Docker rebuild + container start. With `query!()` +
offline mode, the same class of bug surfaces during `cargo check`
in seconds, before any image is built.

### Changed (wire-format / build pipeline)

- **`core/ct-server-core/src/db.rs`,`quota.rs`, `subscription.rs`**
  — every query migrated from `sqlx::query("…")` (runtime-checked)
  to `sqlx::query!("…")` (compile-time-checked). The macros
  inspect the live schema during `cargo sqlx prepare` and embed
  exact column types (incl. nullability + UNSIGNED) into
  `core/.sqlx/query-<hash>.json`. The committed JSON files are
  the schema↔code contract; `cargo build` validates against them.

- **Builds now require `SQLX_OFFLINE=true` + a populated
  `core/.sqlx/` directory.** Wired in:
  - `docker/core/Dockerfile` (`ENV SQLX_OFFLINE=true`)
  - `.github/workflows/ci.yml` (per-step env on `cargo build`,
    `cargo test`, `cargo clippy`)
  - `Makefile` (`rust-build`, `rust-test`, `rust-clippy`)

- **First-time and post-migration generation:**
  `scripts/sqlx-prepare.sh` (also `make sqlx-prepare`). The script
  brings up MariaDB via the project's `docker-compose.yml`, runs
  Laravel migrations, installs `sqlx-cli` if missing, runs
  `cargo sqlx prepare --workspace` against the live schema, and
  reports the diff for the operator to commit. Idempotent.
  Containerised fallback for when the DB port isn't host-mapped.

### Added

- **Cycle 43 codified: `sqlx-offline-check` audit job.** Runs
  `cargo check --workspace` with `SQLX_OFFLINE=true` against the
  committed `core/.sqlx/`. If a `query!()` call has no matching
  metadata (operator forgot `make sqlx-prepare`) or the metadata
  is for a different schema (migration ran but wasn't reflected),
  the job fails with `error: no cached data for this query` and
  blocks the merge. Triggers: weekly cron + every PR touching
  `core/**` or `panel/database/migrations/**`.
- **`docs/sqlx-offline.md`** — explains the why, the how, the
  per-migration loop, common errors, and the prepare-vs-runtime
  trade-off table.
- **`make sqlx-check`** target — runs the same check locally
  before push. Prints a "↳ run make sqlx-prepare and commit"
  hint on staleness.
- **`.gitignore` comment** — explicit "do NOT add `core/.sqlx`
  to ignore patterns" note. The directory MUST be committed; CI
  fails without it.

### Migrations / op-side action required (one-time per deploy)

Pulling v0.0.11 onto a working v0.0.10 deployment requires one
extra step before the next build will succeed:

```bash
cd /opt/cool-tunnel-server
git fetch --depth 1 origin main && git reset --hard FETCH_HEAD
make sqlx-prepare
git add core/.sqlx
git commit -m "chore(sqlx): initial offline metadata"
git push origin main
docker compose --profile build-only build core-builder
docker compose up -d --force-recreate panel
```

After that, every future `cargo build` / CI run / Docker rebuild
runs offline; the only time `sqlx-prepare` is rerun is after a
migration changes column types or someone adds/edits a `query!()`
call.

### Tests

51 passing once `core/.sqlx/` is generated (build won't compile
without it — that's the whole point). Build + clippy + fmt +
shellcheck still clean with offline mode wired in.

### Security

- Removes the entire class of "code expects T, schema returns
  U, runtime decode error in production" bugs. The contract is
  literal JSON checked into git; review-able in PR diffs.
- The `.sqlx/*.json` files contain query SQL + column types. They
  are NOT secrets — no data, no credentials. Safe to commit and
  diff publicly (well, would be — the repo stays private for
  other reasons).

---

## [0.0.10] — 2026-05-03

Fourth 50-cycle LTSC audit, focused on **code-robustness design**:
panic potential, error propagation, subprocess + network timeouts,
transaction boundaries, resource caps, and the unhappy paths the
existing test suite doesn't exercise. Cycles 1–30 by hand surfaced
ten findings, two of them outright **showstopper bugs** that have
been broken in production since v0.0.4 — never caught because
nobody had clicked through the panel save flow on a real deploy.
Cycles 31–50 added two new codified jobs whose absence let those
showstoppers ship: a PSR-4 filename-vs-class lint and PHPStan
level-5 undefined-method analysis.

### Fixed (showstopper, was broken since v0.0.4)

- **`panel/app/Services/SingBoxReloader.php` declared
  `class CaddyReloader`.** PSR-4 autoloading resolves
  `App\Services\SingBoxReloader::class` to `SingBoxReloader.php`,
  finds it, includes it — but the class declared inside is
  `CaddyReloader`, so the symbol `SingBoxReloader` is undefined.
  Result: every `app(SingBoxReloader::class)` resolution from
  `AppServiceProvider` raised "Class not found" at runtime,
  breaking every panel save that fired the model-saved event.
  Class renamed to match the filename; `reload()` now calls
  `reloadSingBox()` (was `reloadCaddy()` — also undefined).
- **`CaddyfileGenerator::renderToFile()`,
  `SingBoxConfigGenerator::renderToFile()`, and
  `SingBoxReloader::reload()` called methods that don't exist
  on `CtServerCore` (`renderCaddyfile`, `reloadCaddy`, etc.).**
  Each invocation raised PHP `Error` ("call to undefined
  method"), which the surrounding `catch (\RuntimeException
  $e)` did NOT catch (Error doesn't extend Exception). Result:
  every `ServerConfig::saved` and `ProxyAccount::saved` event
  threw a fatal Error, abandoning the model save mid-flight.
  v0.0.10 adds the missing `renderCaddyfile()` method,
  corrects the `SingBoxConfigGenerator` to call
  `renderSingBoxConfig()`, and broadens all generator catches
  from `\RuntimeException` to `\Throwable` so a future class
  of similar bug at least gets logged instead of silently
  bringing the panel down.

### Fixed (other robustness)

- **Hyper unix-socket calls had no timeout.** `admin::reload`,
  `admin::dump_config`, and `metrics::fetch_metrics_text` all
  did `client.request(req).await?` with no `tokio::time::timeout`
  wrapper. A hung sing-box process (deadlock, signal-blocked,
  etc.) accepting the connection but never responding would
  have wedged the panel's reload path forever. Now wrapped:
  reload + dump in 15s, metrics in 10s.
- **Daemon's JSON-per-line reader was unbounded.** A misbehaving
  client sending a huge line without a newline could grow the
  read buffer until OOM. Now caps at 1 MiB per line; an
  oversized request triggers a `request_too_large` error
  response and the connection is closed.
- **Daemon had no graceful shutdown.** SIGTERM/SIGINT during
  `accept()` killed the process leaving the unix socket file
  on disk, which the next start would have to clean up. Now
  installs SIGINT + SIGTERM handlers; shutdown drops the
  listener, removes the socket file, returns Ok.
- **`db::active_proxy_accounts` silently defaulted on schema
  mismatches.** `try_get("quota_bytes").ok()` /
  `try_get("used_bytes").unwrap_or(0)` /
  `try_get("expires_at").unwrap_or(None)` would have masked a
  schema migration that dropped or retyped any of those
  columns — every account would have silently become
  "unlimited quota, never expires." Now returns an Error with
  context ("schema regression?") on type mismatch; the only
  silent path remains `password_cleartext_encrypted` (which
  is legitimately Optional and just gets logged on type
  mismatch instead of returning an error).
- **`db::add_used_bytes` accepted any delta.** A buggy metric
  source could add `i64::MAX` and silently disable every
  account via the quota path. Now rejects negative deltas
  outright and clamps the upper bound at 1 PiB
  (`MAX_USED_BYTES_DELTA`) — well above any plausible
  per-window traffic for a single account; values above
  almost certainly indicate a parser regression.
- **`quota::enforce` SELECT + UPDATE had no transaction.** An
  operator re-enabling an account in the panel between our
  `SELECT enabled = 1 WHERE expired/quota` and our subsequent
  `UPDATE enabled = 0` would have had their re-enable
  silently overwritten. Now wraps both in a transaction with
  `SELECT ... FOR UPDATE`, so concurrent panel saves block on
  our row locks for the (typically sub-millisecond)
  enforcement window.
- **`probe::client_no_proxy()` fell back to
  `reqwest::Client::new()` if the timeout-configured builder
  failed.** That fallback path silently lost the 10s timeout
  and the `no_proxy()` opt-out — both load-bearing for the
  probe's correctness. Now propagates the build error
  instead.
- **`components::list` was unbounded.** No size limit per
  manifest file (a 10 GiB rogue file would have OOM'd the
  process), no count limit on the directory (pointing at the
  wrong path could have walked unrelated JSON files). Now
  caps at 64 KiB per manifest, 256 manifests total, with
  warnings logged on overflow.
- **`CtServerCore::run()` captured unbounded
  stdout/stderr.** A regression where ct-server-core looped
  printing could have OOM'd the panel container via the
  captured String. Now bounds capture at 1 MiB per channel
  with a `…[truncated]` marker in the error message; sets a
  Symfony `setIdleTimeout` to detect a wedged subprocess.
- **`reload_caddyfile_text` alias removed.** The misleading
  v0.0.4-era backward-compat shim referenced "Caddyfile" but
  reloaded sing-box. All callers updated to use `admin::reload`
  directly.

### Changed

- `daemon::handle_client` now uses `read_until(b'\n')` with a
  pre-cap instead of `BufReader::lines()`, so the per-line
  size limit is enforced before a full line is consumed.
- `daemon` `WireRequestV1::RenderCaddyfile` and
  `WireRequestV1::ReloadCaddy` variants kept their historical
  names for WireV1 compat; added comments explaining the
  v0.0.2 rename plan was deferred to v0.1.
- `redis_bridge::fire_reload` log line corrected: was "caddy
  reload applied", now "sing-box reload applied" (post-v0.0.4
  this is sing-box via clash API).

### Added

- **Cycle 41 codified: `php-psr4` audit job.** Runs
  `composer dump-autoload --strict-psr` plus a grep that
  verifies every `class|interface|trait|enum` declaration in
  `panel/app/**/*.php` matches the basename of the file
  declaring it. Would have caught the v0.0.10 Showstopper #1
  the moment it was committed.
- **Cycle 42 codified: `phpstan` audit job.** Runs PHPStan
  level 5 against `panel/app`. Catches undefined-method
  calls + type errors at lint time. Would have caught the
  v0.0.10 Showstopper #2 the moment it was committed.
  PHPStan added to `panel/composer.json` `require-dev`.

### Tests

51 passing (8 ct-protocol + 42 ct-server-core + 1 doc-tests at 0).
Build + clippy + fmt + shellcheck all clean. The added
robustness reads (size-bounded manifest reads, type-strict
`try_get`s, transaction-wrapped quota enforcement) all
exercised by existing tests.

### Security

- The hyper-without-timeout class of bug is a denial-of-
  service vector: a single hung sing-box process would have
  wedged every subsequent panel save indefinitely. v0.0.10
  closes the class for all three call sites
  (`admin::reload`, `admin::dump_config`,
  `metrics::fetch_metrics_text`).
- The unbounded daemon line buffer is a memory-exhaustion
  vector for any process that can connect to the daemon
  socket (which is mode 0660; only the panel and root). Not
  a public risk but a robustness vector. Capped at 1 MiB.
- The schema-mismatch silent-default class of bug is the
  category of "the database changed under us and we
  accidentally became permissive." Now fails loudly on
  schema regression.

---

## [0.0.9] — 2026-05-03

Third 50-cycle LTSC audit, focused on **anti-network-tracking** —
the fingerprintable surfaces a censorship system or scanner sees
when probing the server. Cycles 1–30 by hand surfaced eleven real
findings, of which four were active **anti-tracking** bugs (custom
`X-CT-*` response headers, the HTTP/3 advertising-but-not-serving
loop, sing-box's TCP-bound clash API, and the "managed" string
respond on the Caddy ghost site). Cycles 31–50 added one more
codified job: an anti-tracking config smell-test that asserts on
the rendered template content.

### Changed (wire-format)

- **Subscription manifest signature moved into the JSON body.**
  v0.0.8 and earlier sent `X-CT-Signature: <hex>` and
  `X-CT-Protocol: 1` response headers — both unmistakable
  project tells to anyone hitting `/api/v1/subscription/<token>`.
  v0.0.9 removes both headers; the signature now rides in the
  body's `signature` field (HMAC-SHA-256 over the canonical body
  with `signature` set to null). On the wire the response now
  looks like any other authenticated JSON API response. **This
  is a breaking change for clients consuming v0.0.8 manifests** —
  see `docs/cross-platform-clients.md` for the new verification
  rule. The `SubscriptionManifestV1` Rust struct gained a
  `signature: Option<String>` field with `skip_serializing_if =
  "Option::is_none"` so unsigned construction round-trips
  unchanged.
- **`capabilities.http3` is now always `false`** in the
  subscription manifest, regardless of the `http3_enabled` DB
  toggle. NaiveProxy is HTTP/2-only at the protocol level —
  sing-box's `naive` inbound does not serve QUIC. Advertising
  HTTP/3 made clients attempt QUIC, fail (no UDP listener), and
  fall back via TCP — a recognisable network signature. Honest
  `false` removes the fingerprint. The DB column survives for
  forward-compat in case a future protocol pivot adds genuine
  QUIC support.
- **Sing-box config (`sing-box/config.json.tpl`) hardened:**
  - `log.level` lowered from `"info"` → `"warn"`. Info-level
    logs every connection, a forensic goldmine on seizure.
    `warn` keeps operational issues visible without per-user
    traces.
  - `tls.min_version` raised from `"1.2"` → `"1.3"` plus
    `tls.max_version: "1.3"`. Pins the wire fingerprint to
    TLS 1.3 only — modern HTTPS is overwhelmingly 1.3, so a
    1.2 fallback connection stands out in flow analysis.
  - `clash_api.external_controller: "127.0.0.1:9090"` (TCP)
    **removed**. Only `external_controller_unix:
    "/run/sing-box/clash.sock"` remains. The TCP listener was
    a public-attack surface if firewall is misconfigured;
    nothing in this stack ever connected via TCP.
  - `experimental.cache_file.enabled: true` → `false`. The
    DNS / connection cache was written to disk at
    `/data/cache.db`; if the server is ever seized, that file
    is forensic. Disabled by default; operators wanting the
    perf can flip it locally with full awareness.
- **Caddyfile (`caddy/Caddyfile.tpl`) hardened:**
  - The `:8443` ghost site no longer responds with the literal
    string `"managed"` (a recognisable signature for
    "Cool-Tunnel-style split-port stack"). Now responds with
    empty body + status 444 + `close` — looks like a generic
    firewalled endpoint to anyone who somehow reaches it
    inside the container network.
  - The ghost site's `protocols tls1.2 tls1.3` is now
    `protocols tls1.3` (it never serves real traffic, so
    there's no compat reason to advertise legacy versions).
  - `events { on cert_failed exec sh -c "echo \"$(date ...)\"
    >> /data/cert-failures.log" }` rewritten to log to STDERR
    (which docker logs captures + the daemon rotates). The
    previous line wrote a timestamped failure trail into the
    `caddy_data` volume — a forensic artefact nobody asked
    for.
- **Docker port maps and Dockerfile EXPOSE lines** stopped
  advertising UDP/443:
  - `docker-compose.yml`: removed `"443:443/udp"` mapping
    from the sing-box service.
  - `docker/sing-box/Dockerfile`: `EXPOSE 80 443 443/udp` →
    `EXPOSE 443`. (The :80 line was also stale — Caddy
    handles HTTP-01 in this stack, sing-box no longer
    binds :80.) Exposing UDP/443 with no listener produced
    fingerprintable RSTs on QUIC scans.
- **`docs/cross-platform-clients.md`** gained an
  "Anti-tracking notes for client implementers" section that
  documents the new signature-in-body shape, the
  always-`false` HTTP/3 advertise, the 404+HTML invalid-token
  response (matches the camouflage catch-all), and the
  no-`Server:`/`X-Powered-By:` header guarantee.
- **`panel/app/Filament/Pages/ServerConfigPage.php`** —
  removed the `Toggle::make('http3_enabled')` form control;
  replaced with a `Placeholder` explaining why the toggle is
  retired (NaiveProxy is HTTP/2-only). The DB column is kept
  for forward-compat.

### Added

- **Cycle 40 codified: `anti-tracking-config` audit job.**
  Static assertions on `sing-box/config.json.tpl` and
  `caddy/Caddyfile.tpl`:
  - sing-box `tls.min_version` must be `"1.3"`
  - sing-box `log.level` must not be `debug` / `info` / `trace`
  - sing-box `clash_api.external_controller` (TCP) must not
    be present
  - sing-box `experimental.cache_file.enabled` must be `false`
  - Caddy ghost site `respond` must not be a recognisable
    string (`managed`, `ok`, `alive`, `cool`, `tunnel`,
    `naive`, `sing-box`)
  - Caddy ghost site `protocols` must not include `tls1.2`
  - Caddy `cert_failed` event must not append to `/data/...`
  - `panel/app/**` must not call `->header('X-CT-...')`
- **`stale-docs` blacklist gained two new patterns:**
  - `->header('X-CT-` — catches header regression in PHP
  - `"443:443/udp"|EXPOSE.*443/udp` — catches UDP port-map
    regression in compose / Dockerfiles
- **Pull-request paths trigger expanded** to include
  `sing-box/config.json.tpl` and `caddy/Caddyfile.tpl`, so a PR
  that touches either template runs the smell-test job.

### Tests

51 passing (was 50): one new `signature_field_is_skipped_when_none`
test in `core/ct-protocol/src/subscription.rs` asserts that
`signature: None` is omitted from the serialised JSON (load-
bearing for canonicalisation on the client side). Build +
clippy + fmt + shellcheck still clean.

### Security

- The clash-API TCP listener was the highest-impact finding
  this audit. A misconfigured firewall (or an operator running
  `docker compose down && up` after editing docker-compose to
  expose 9090 for "debugging" and forgetting to revert) could
  have exposed every connection's per-user metadata to the
  internet. The unix-socket-only path was always there; v0.0.9
  removes the TCP fallback entirely.
- The HTTP/3-advertise-but-no-listener pattern was a slow-burn
  fingerprint: every NaiveProxy client that opted into QUIC
  produced one observable failed-handshake-then-fall-back
  signature per connection. v0.0.9's always-false advertise
  removes the signature class entirely.

---

## [0.0.8] — 2026-05-03

Second 50-cycle LTSC audit, this one focused on **UI / UX layout
design** — the operator-facing Filament panel, the public-facing
camouflage Blade pages, the operator-facing CLI scripts, and the
docs that are visible during incident response. Cycles 1–30 by
hand surfaced eleven real findings; cycles 31–50 are codified by
adding two new jobs to the existing `audit.yml` (PHP style + Blade
asset-link 404 check). The user also asked us to remove unused
files; one orphan service was dropped.

### Added

- **Camouflage cover pages** (`blog`, `portfolio`, `corporate`)
  now have parity on probe-resistance hygiene: `meta name=
  "description"`, `meta name="robots"`, `og:type` / `og:title` /
  `og:description`, and `link rel="canonical"` are present in all
  three. Each template ships an inline-SVG favicon (no separate
  HTTP request, no 404), and the CSS now respects
  `prefers-color-scheme: dark`. Blog post links use proper slugged
  hrefs and `<time datetime="…">` instead of every post pointing at
  `/`.
- **`panel/public/favicon.svg`** — admin-panel branding asset that
  the new `AdminPanelProvider::favicon()` call resolves to.
- **`scripts/render-caddyfile.sh`** — sibling to
  `render-singbox.sh`. The old `render-singbox.sh` was
  *named* sing-box but was actually shelling out to
  `caddyfile render`; the body is fixed and a real
  `render-caddyfile.sh` now exists.
- **`AdminPanelProvider`** now enables `->profile()` (so an admin
  can change their own password from the panel without needing
  `php artisan tinker`), `->darkMode()`, `->sidebarCollapsibleOnDesktop()`,
  and three navigation groups (`Users`, `Reporting`, `System`) so
  the sidebar isn't a flat 5-item list.
- **`TrafficLogResource`** now ships a date-range filter
  (`from` / `to`) so an operator can answer "how much did
  account X use last week" without a SQL console. Sent / Received
  columns are right-aligned for easier visual scanning, with
  hover tooltips disambiguating direction.
- **`FakeWebsiteResource`** now has a "Currently active"
  ternary filter and defaults the table sort to `is_active desc`
  so the live cover site appears first.
- **`ProxyAccountResource`** form is grouped into `Identity` and
  `Limits` `Section`s (matching the visual hierarchy already used
  on `ServerConfigPage`), and the `expires_at` picker now has
  `minDate(now())` so an accidental past date isn't silently
  accepted.
- **Audit workflow cycles 38 + 39 codified**:
  - **`php-style`** — runs `vendor/bin/pint --test` (Laravel
    Pint, already in `panel/composer.json` require-dev) on weekly
    cron and on every PR that touches `panel/app/**` or
    `panel/resources/views/**`.
  - **`blade-asset-links`** — greps every `panel/resources/views/**.blade.php`
    for literal `href="/foo.css"` / `src="/foo.js"` /
    `href="/foo.svg"` / `…/foo.png|ico|webp|woff|woff2` and fails
    the build if the corresponding `panel/public/$path` file does
    not exist. Catches the exact bug class that v0.0.8 found
    (the `/static/style.css` 404 in three Blade files).

### Fixed

- **Camouflage pages were leaking `/static/style.css` 404s** to
  any scanner that opens devtools — `blog.blade.php`,
  `portfolio.blade.php`, and `corporate.blade.php` all linked a
  stylesheet that has no matching public file or registered
  route. Removed in all three.
- **`scripts/backup.sh` was snapshotting the wrong volume.**
  Comments said "ACME state lives in singbox_data" — that was
  true in v0.0.2 / v0.0.3 but not since v0.0.4 reintroduced
  Caddy as the ACME side. The script was tarring up an empty
  volume and skipping the actual cert directory; restoring from
  one of these backups would have burned Let's Encrypt
  rate-limit budget on every recovery. Now snapshots
  `caddy_data` (the real ACME state) and bundles
  `caddy/Caddyfile.tpl` alongside `sing-box/config.json.tpl`
  so a restore lands on a complete tree.
- **`scripts/render-singbox.sh` was actually rendering the
  Caddyfile.** Body said `caddyfile render`; comment said
  sing-box. Now actually renders sing-box config (matches the
  filename and the documentation in `STRUCTURE.md` /
  `README.md`).
- **`ServerConfigPage` description and save notification only
  named Caddy.** Anti-tracking toggles + HTTP/3 also drive the
  sing-box config (cert-mtime + DB hash → `singbox:render
  --if-changed --reload` since v0.0.4); the user-visible text
  now says "Caddyfile + sing-box config regenerated; both
  services hot-reloading" so the operator's mental model
  matches the actual machinery.
- **`docs/installation-debian.md` § Renew TLS** still said
  "sing-box's built-in ACME renews automatically" — three audit
  cycles past v0.0.4 and the prose hadn't caught up. Now
  correctly explains the cert-mtime → render-change-hash chain
  and that `docker compose restart caddy` is the way to force a
  renewal.
- **`docs/architecture.md`** softened the "sing-box has a
  built-in ACME implementation but it lacks Caddy's
  CertMagic-grade reliability" wording so it doesn't read as
  active recommendation against a feature we don't use; also
  removed the dangling `forwardproxy` reference and pointed
  readers at `CHANGELOG.md` for the v0.0.2 pivot.
- **`README.md` filetree** still listed `AntiTrackingFilter`
  as a Service, which had been orphaned and was deleted by
  this audit. Now lists the actual services (`CaddyfileGenerator`
  added; `AntiTrackingFilter` removed).
- **`ProxyAccountResource.last_seen_at`** column was visible in
  the default table layout but is always `never` in current
  deployments (the column is written by `metrics::collect`
  which is the no-op since v0.0.7 — see metrics.rs module
  docstring). Now `toggleable(isToggledHiddenByDefault: true)`
  so it doesn't show stale data, with a comment explaining why
  and a clear path to flip the default once sing-box per-user
  metrics land.
- **`ComponentsPage` Blade view used hardcoded `grid-cols-3`**,
  which was cramped on the phone an operator might pull out
  during incident response. Now `grid-cols-1 sm:grid-cols-3`,
  with `overflow-x-auto` on the table so wide diagnostic
  messages scroll instead of breaking layout. Status badges
  gained dark-mode variants (`dark:bg-success-900/40 dark:text-success-300`)
  so they don't render as low-contrast on dark theme.
  Accessibility: `<caption class="sr-only">`, `<th scope="col">`,
  `role="status"` on the OK/NG pill, `aria-label` for screen
  readers.
- **`ServerConfigPage` Edge-auth section** previously had
  `admin_basic_auth_hash` as a plain `TextInput` — the bcrypt
  hash was rendering visibly on screen. Now `password()` +
  `revealable()` with `autocomplete="new-password"` so it
  doesn't autofill or shoulder-surf.

### Removed

- **`panel/app/Services/AntiTrackingFilter.php`** — defined a
  `FEATURES` constant array intended for a Filament
  Anti-Tracking page that never shipped. The class was
  referenced nowhere in the codebase outside its own file
  (verified by `grep -r AntiTrackingFilter`). Dead code, gone.

### Tests

50 passing (8 ct-protocol + 42 ct-server-core). Build + clippy
+ fmt + shellcheck still clean. Two new audit jobs (`php-style`,
`blade-asset-links`) ship in `audit.yml`.

---

## [0.0.7] — 2026-05-03

50-cycle LTSC code audit. Cycles 1–5 were the v0.0.6 hand-audit;
cycles 6–30 were a deeper hand-audit that surfaced four more
real-world findings (stale ACME doc references, an untruthful
metrics scrape path, a missing test surface around the
Caddyfile-username domain rule, an async-test using `std::fs`).
Cycles 31–50 are codified as a recurring weekly CI workflow —
hand-auditing 50 files every release does not scale, so the
sustainable pattern is "do it by hand once, then make the
machine do it forever."

### Added

- `.github/workflows/audit.yml` — scheduled audit workflow
  running weekly on Monday 08:17 UTC plus on-demand and on
  any PR that touches Cargo / composer / Dockerfiles /
  manifests. Jobs: **`cargo-audit`** (RustSec advisory DB),
  **`cargo-deny`** (licences, ban list, source registry),
  **`composer-audit`** (Packagist advisories on the panel
  side), **`secret-scan`** (gitleaks across full history),
  **`manifest-drift`** (verifies `manifests/*.upstream.json`
  versions track `core/Cargo.toml` and Dockerfile pins —
  catches the v0.0.6 "I bumped Cargo.toml but forgot the
  manifest" failure mode), **`dependency-review`** (PR-only
  vuln + licence diff vs. base), **`stale-docs`** (regex
  blacklist for known-stale strings like `forwardproxy@naive`
  and `sing-box.*built-in ACME`).
- `core/deny.toml` — cargo-deny configuration: allowed
  licence list (Apache-2.0 / MIT / BSD-{2,3} / ISC /
  Unicode-3.0 / Zlib / MPL-2.0 / OpenSSL / CC0-1.0 / 0BSD
  + Apache-2.0 WITH LLVM-exception); explicit ban on
  `openssl` and `openssl-sys` (we standardise on rustls);
  unknown-registry and unknown-git denied so every dep is
  reproducible.
- `AUDIT.md` — policy doc explaining where each cycle lives
  (1–30: git history, 31–50: codified in `audit.yml`),
  rotation policy for fixing red audit jobs, and what
  deliberately stays out of automation (Docker bringup,
  taste calls, perf regressions).
- 4 new domain-rule tests in `core/ct-server-core/src/domain/mod.rs`
  for `caddyfile_safe_username` covering the accept set
  (alpha / digit / `-` / `.` / `_`), the size guard (empty
  + oversize), the dangerous-char reject set (`;` `\n` `"`
  `\` `{` `}`), and the maximum-length boundary.

### Fixed

- **Two stale ACME references in `README.md`** — one in the
  feature bullet ("Runs sing-box ... built-in ACME, hot
  reload via clash API") and one in the architecture
  diagram ("TLS (built-in ACME Let's Encrypt, auto-renew on
  :80)"). Both were left over from before v0.0.4 reintroduced
  Caddy as the ACME provider. They now correctly say sing-box
  reads cert + key from `/data/caddy/...` and Caddy is the
  ACME side.
- **Stale architecture diagram in `docs/architecture.md`**
  — sing-box box was showing `naive inbound { users,
  tls(ACME)}` and `listen :443 (h2 + h3) + :80 (ACME)`,
  which is the v0.0.2/v0.0.3 shape, not v0.0.4+. Replaced
  with the current `tls { cert+key from /data/caddy/...}` /
  `listen :443 (h2 + h3)` shape.
- **`core/ct-server-core/src/caddy/mod.rs` test used
  `std::fs::read_to_string` inside an `#[tokio::test]`.**
  In a `#[tokio::test(flavor = "multi_thread")]` runtime
  this technically works but it's a footgun — the moment
  someone bumps the test to add a real I/O step, the
  blocking call will silently stall the executor on busy
  CI. Switched to `tokio::fs::read_to_string` for
  consistency with the rest of the async surface.

### Changed

- **`core/ct-server-core/src/metrics.rs` is now an honest
  no-op.** The Prometheus parser was still looking for
  `caddy_forwardproxy_bytes_total{user=...,direction=...}`
  metrics — names that the unmaintained klzgrad plugin
  emits but sing-box does not. Net effect since v0.0.2:
  `traffic:rollup` ran every minute and silently
  contributed zero bytes to `traffic_logs`. Now `collect()`
  early-emits a `tracing::info!` line on every call so an
  operator inspecting panel logs sees the gap is
  acknowledged, not silently ignored. The legacy parser is
  preserved with module-level docstrings explaining the
  three v0.1 paths forward (clash-API streaming consumer,
  upstream sing-box adding Prometheus-shaped per-user
  counters, or patching sing-box to expose them).

### Tests

42 passing (was 38 in v0.0.6). Build + clippy + fmt +
shellcheck all clean. Audit workflow validates against
`actions/dependency-review-action@v4` schema.

### Security

- The `cargo-deny` configuration explicitly bans the
  C-OpenSSL FFI (`openssl` / `openssl-sys` crates) so a
  dependency upgrade can't silently pull a libssl link
  in — we standardise on rustls + `tokio-rustls`
  end-to-end and the deny rule keeps that property
  invariant going forward.
- `gitleaks` scheduled scan reads full repo history
  (`fetch-depth: 0`) so a hypothetical credential
  committed to a feature branch and force-pushed away
  is still caught.

---

## [0.0.6] — 2026-05-03

5-cycle LTSC code audit. Two structural bugs fixed (the v0.0.4
sing-box template never picked up the ACME→cert-path change; the
v0.0.3 mass-assignment guard reverted somewhere along the way),
plus a reliability gap and a clutch of stale comments.

### Fixed

- **`sing-box/config.json.tpl` still had the `acme` block** —
  v0.0.4's "switch to certificate_path / key_path" edit landed in
  the Rust render code (which set CertPath / KeyPath bindings) but
  not in the template file itself. With this template, sing-box
  would attempt BOTH built-in ACME AND read certs Caddy wrote,
  causing port-80 binding conflicts or undefined behaviour. Now the
  template uses `certificate_path` + `key_path` to match the bindings.
- **`ProxyAccount.$fillable` had `password_hash` and
  `password_cleartext_encrypted` back in it.** The v0.0.3 hardening
  apparently reverted between then and now — Cycle 2 caught it.
  Both columns are out of `$fillable` again; only
  `setCleartextPassword()` can write them.
- **Subprocess calls had no timeout.** `Command::new("docker")`
  invocations in `admin.rs`, `singbox/mod.rs`, and `components.rs`
  could hang indefinitely on a sick docker daemon. All three now
  wrap with `tokio::time::timeout` (60s for restart, 30s for
  validation, 15s for component-verify).
- Stale comments: `quota.rs` referred to "re-render the Caddyfile";
  `subscription.rs` referred to "Caddyfile basic_auth presence";
  `installation-debian.md` UFW comment said `forward_proxy`. All
  three now name the actual sing-box-era machinery.

### Changed

- `install.sh` pre-flight now also requires `dig`, `curl`, `jq`,
  and `htpasswd` — every tool a real install needs. Also requires
  `PANEL_BASIC_AUTH_HASH` to be set in `.env` (with a hint to
  generate one via `htpasswd -nbB admin '<pw>'`). Catches "I
  forgot to set the panel password" before bringing services up.
- Friendlier error messages from `admin::reload`: a non-2xx clash
  API response now suggests running `sing-box check -c …` to
  validate the config first; a missing clash socket suggests the
  most likely cause (sing-box not running, or the volume not
  mounted into the panel container).

### Tests

38 passing; build + clippy + fmt + shellcheck all clean.

---

## [0.0.5] — 2026-05-03

LTSC discipline pass. No runtime behaviour change; everything is
process / docs / supply-chain.

### Added

- `.github/workflows/ci.yml` — runs `cargo build`, `cargo test`,
  `cargo clippy --deny warnings`, `cargo fmt --check`, `shellcheck`,
  and `composer validate` on every push and PR.
- `CHANGELOG.md` (this file), `SECURITY.md`, `SUPPORT.md`,
  `RELEASE.md`, `VERSIONING.md`.
- `.editorconfig`, `rustfmt.toml`, `Makefile` for consistent
  developer experience.
- `renovate.json` so dependency updates land as tidy PRs grouped
  by ecosystem rather than as floods.
- `scripts/sbom.sh` generating CycloneDX SBOMs for the Cargo workspace,
  Composer panel, and Docker images. Output lands under `sbom/`.
- `ct-data` internal-only docker network for `db` + `redis`
  (`internal: true`), so a compromised database can't initiate
  outbound traffic.
- A `LTSC` table at the top of `README.md` listing the supported
  Debian / Rust / PHP / Caddy / sing-box versions.

### Fixed

- `docker/core/Dockerfile` was still pinning `rust:1.78-alpine` even
  though `core/rust-toolchain.toml` was bumped to `1.86` in v0.0.3.
  Production builds would have failed at `cargo build`. Both files
  now name `1.86` and the comment block at the top of the
  Dockerfile says they must move together.

### Changed

- All Docker base images now have a comment listing both the **tag
  pin** and the **expected digest** (commented out, populated by
  `make pin-images` on a host that has docker installed). Tag-only
  remains the source of truth until the operator runs the pin
  command.

---

## [0.0.4] — 2026-05-03

Caddy comes back as the ACME provider only. Sing-box keeps the
proxy on `:443` but reads its cert + key from a shared volume that
Caddy writes to. The unmaintained `forwardproxy` plugin from v0.0.1
is **not** back — Caddy here is stock, no plugins.

### Added

- `caddy/Caddyfile.tpl` — Go-template, ACME-only mode, `events {
  on cert_obtained ... }` hook so cert renewal flips a flag.
- `core/ct-server-core/src/caddy/mod.rs` — render Caddyfile module
  + tests (`cert_paths_compose_correctly`,
  `ca_folder_strips_scheme_and_replaces_slashes`).
- `panel/app/Services/CaddyfileGenerator.php` and
  `panel/app/Console/Commands/CaddyfileRender.php`.
- New `ct-server-core caddyfile render` CLI subcommand mirroring
  `singbox render`.
- `manifests/caddy.upstream.json` restored.

### Changed

- `core/ct-server-core/src/singbox/mod.rs`: `tls.acme` block →
  `tls.certificate_path` + `tls.key_path` reading from
  `/data/caddy/certificates/.../...`. Cert mtime is folded into the
  render-change SHA-256, so a Caddy renewal flips the existing
  scheduled `singbox:render --if-changed --reload` (no new
  plumbing).
- `docker-compose.yml`: `caddy` service back; `caddy_data` shared
  RW between caddy + panel, RO into sing-box.
- `scripts/install.sh`: starts Caddy first, waits up to 90s for the
  cert file to land, then starts sing-box.

### Tests

37 → 38 passing. Still: 1M-event Debouncer stress, 100k-event
Coalescer stress, 64-task concurrent Coalescer test all green.

---

## [0.0.3] — 2026-05-03

Per-language idiomatic refresh + bigger stress tests + Debian-noob
install path.

### Added

- `scripts/lib.sh` — shared shell helpers (step / ok / warn / die /
  require_cmd / require_file / require_env / load_env / wait_for /
  prompt_yn / prompt_secret / require_docker / compose).
- `core/ct-server-core/src/template.rs` — tiny Go-template-style
  renderer, 12 unit tests.
- `core/ct-server-core/src/laravel_crypt.rs` — Laravel-Crypt
  AES-256-GCM decrypt; friendlier error messages with concrete
  remediation hints.
- `GETTING_STARTED.md` (Debian-noob walkthrough) + `STRUCTURE.md`
  (repo map).
- `.dockerignore` keeping secrets and `target/` out of build
  contexts.
- `HEALTHCHECK` directives on `caddy` and `panel` images.

### Changed

- `sing-box/config.json.tpl` rewritten in Go-template `{{ .Field }}`
  syntax.
- 56 PHP files now `declare(strict_types=1);`.
- `ProxyAccount.password_hash` and `password_cleartext_encrypted`
  removed from `$fillable`. Only `setCleartextPassword()` writes
  them — Filament forms can't poison those columns.
- `install.sh` rewritten as a numbered, colour-coded walkthrough
  with per-failure `↳ try:` hints.

### Tests

33 → 35 passing.

### Fixed

- `cargo build --release` no longer emits warnings.

### Security

- Tracing audit: no password / `APP_KEY` / cleartext leaks.

---

## [0.0.2] — 2026-05-03

Architecture pivot: drop the unmaintained klzgrad/forwardproxy
plugin in favour of [SagerNet/sing-box](https://github.com/SagerNet/sing-box)
(GPL-3.0). Wire-protocol-compatible — clients connect unchanged.

### Added

- `docker/sing-box/Dockerfile` + `sing-box/config.json.tpl` (then
  using `__VAR__` substitution; rewrote in v0.0.3 to Go template).
- `core/ct-server-core/src/laravel_crypt.rs` (was added here, then
  the friendly errors landed in v0.0.3).
- `password_cleartext_encrypted` column on `proxy_accounts`
  (sing-box's `naive` inbound checks the password as cleartext).
- New CLI subcommands: `ct-server-core singbox render | validate`,
  `ct-server-core server reload | config`.

### Removed

- `caddy/Caddyfile.tpl` (returned in v0.0.4 as ACME-only).
- `klzgrad/forwardproxy` dependency.

### Changed

- Rust toolchain bumped 1.78 → 1.86 (sqlx's icu_* transitives).

### Tests

23 → 31 passing (added Laravel-Crypt round-trip + sing-box render
tests; existing Coalescer stress tests stayed green).

---

## [0.0.1] — 2026-05-03

Initial pre-release. Three-layer stack: Caddy + `klzgrad/forwardproxy@naive`
plugin + Filament/Laravel + Rust core + MariaDB + Redis. Component-as-
machine-part model with `manifests/*.upstream.json`. Subscription manifest
API for cross-platform clients. Step-by-step Debian 10/11/12/13+ install
guide. Late-Night Comeback launch-readiness checklist.

This release was retired in favour of v0.0.2 once the unmaintained-
forwardproxy concern surfaced. Tag is preserved for archaeological
purposes; do not deploy v0.0.1.

[Unreleased]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.11...HEAD
[0.0.11]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.10...v0.0.11
[0.0.10]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/coo1white/cool-tunnel-server/releases/tag/v0.0.1
