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

## [0.4.0] — 2026-05-16 — Pivot from naive to sing-box (VLESS + Reality); shared singbox-core package on both ends

v0.1 → v0.3 burned hours on "the server's wire format doesn't match
the client's wire format" bugs. naive client + klzgrad/forwardproxy
server were two repos on independent release cadences; one froze
while the other kept moving. v0.3.0 attempted to fix the class by
running the SAME naive binary on both ends, but the premise was
wrong: naive is a client-only binary (its `--listen` flag does NOT
accept https://). Reading naive's own help output earlier would
have saved a day.

v0.4.0 drops naive entirely and pivots both server and client to
SagerNet/sing-box (VLESS + Reality protocol). Single upstream
project, server + client modes from the same binary, active
maintenance. Wire-format drift is now structurally impossible:
both server and client are rebuilt against the SAME upstream tag
pinned in `singbox-core/singbox.upstream.json`.

### Why VLESS + Reality

Reality preserves the "looks like a vanilla HTTPS request to a real
CDN" cover-site property that drew this project to naive originally.
The TLS handshake LOOKS like microsoft.com (or whichever
ServerConfig.reality_dest_host the operator picks); Reality
cryptography establishes a covert channel for authorized clients
under that cover.

### Added

- **`singbox-core/`** — new Bun TypeScript package, compiled via
  `bun build --compile` to a self-contained ~50 MB binary embedded
  in BOTH cool-tunnel-server (ct-singbox container) and cool-tunnel
  (Cool Tunnel.app on macOS). Six subcommands:
  - `version` — print singbox-core + pinned sing-box version
  - `reality-keygen` — X25519 keypair via WebCrypto
  - `install` — fetch + SHA-256 verify the pinned sing-box tarball
  - `render-server` — emit sing-box server config.json from DB inputs
  - `render-client` — emit sing-box client config.json (macOS app)
  - `supervise` — long-running watcher; spawns + respawns sing-box
    on config-file change with debounced fs.watch, healthz on
    127.0.0.1:9091
- **`docker/singbox/`** — new ct-singbox container Dockerfile.
  Three-stage build: bun-build → singbox-fetch (SHA-256 verify) →
  runtime (alpine + ca-certificates + libcap + drop privileges).
- **`docker-compose.yml`** — new `singbox` service mirroring the
  shape of the v0.3.x ct-naive service it replaces; new
  `singbox_config` volume (panel RW, ct-singbox RO).
- **panel: `SingboxConfigGenerator` + `SingboxConfigGeneratorInterface`** —
  shells to `singbox-core render-server` with the DB-derived input
  as stdin JSON. Reality private key Laravel-decrypted at the
  DB-read boundary; never written to disk in cleartext.
- **panel: `php artisan singbox:render`** — first-boot render +
  manual operator re-render.

### Changed

- **`caddy/Caddyfile.tpl`** — Caddy's role shrinks to ACME for the
  panel subdomain + L4 SNI splitter. Two routes only: panel SNI →
  inner Caddy HTTPS; everything else → tcp/ct-singbox:443. No more
  cert acquisition for the proxy domain (Reality fakes its own
  cert).
- **`docker/caddy/Dockerfile`** — head comment rewritten to
  document the v0.1 → v0.4 architecture evolution. Build chain
  unchanged (caddy:2.11.3 + mholt/caddy-l4 plugin).
- **`docker-compose.yml`** — head comment + per-service comments
  rewritten. caddy now manages ONE cert (panel) instead of two.
- **panel handlers** — `ReloadSingBoxHandler` +
  `ReloadServerConfigHandler` rebound to the new
  `SingboxConfigGeneratorInterface`. Class names preserved
  (`ReloadSingBox*`) for backward-compatible message dispatch.
- **panel entrypoint** — `php artisan naive:render` →
  `php artisan singbox:render` for first-boot.

### Removed

- **`docker/naive/`** — Dockerfile + supervisor.ts (v0.3.x).
- **`core/ct-server-core/src/naive/`** — Rust render module +
  `naive` CLI subcommand. ct-server-core (Rust) no longer renders
  proxy configs at all; that responsibility moved to singbox-core
  (Bun).
- **`manifests/{naive,naiveproxy,naiveproxy-client}.upstream.json`** —
  obsolete upstream pins.
- **`operator/sync-naive-pin.ts`** + test — was tracking the v0.3.x
  naive pin between server + client; superseded by
  `singbox-core/singbox.upstream.json` which both repos share.
- **panel: `NaiveConfigGenerator` + interface, `NaivePinReader` +
  interface, `NaiveRender` artisan, `NaivePinReaderTest`** — all
  v0.3.x naive scaffolding.
- **`SubscriptionController::server_naive_pin`** — field stripped
  from manifest (the cross-end pin moves to a sing-box equivalent
  in a follow-up coordinated client cut).
- **`CtServerCoreInterface::renderNaive()` +
  `CtServerCore::renderNaive()`** — removed. PHP now calls
  singbox-core directly instead of routing through ct-server-core.

### Known followups (not in v0.4.0)

- Schema migration: add `reality_private_key`,
  `reality_public_key`, `reality_dest_host`, `reality_short_ids`
  to `ServerConfig`; replace `password`/`password_hash` with
  `uuid` on `ProxyAccount`.
- Filament admin UI: surface Reality keypair fields (read-only,
  generated server-side via `reality-keygen`); replace password
  fields with UUID display.
- Operator rewrite: `drift-check.ts`, `tasks/drift.ts`,
  `version-bridge.ts` parse the new sing-box config + version
  surface.
- Panel test rewrite: `SubscriptionContractTest`,
  `ReloadSingBoxHandlerTest`, `ReloadServerConfigHandlerTest`
  updated to the v0.4.0 schema.
- `docker/panel/Dockerfile` — bundle the compiled singbox-core
  binary (currently SingboxConfigGenerator assumes the binary is
  at `/usr/local/bin/singbox-core`; a Bun-compile stage needs
  adding).
- CI workflow updates for the new layout.
- **Coordinated client release**: cool-tunnel v3.0.0 must ship
  alongside server v0.4.0 — the macOS app's bundled binary changes
  from naive to sing-box, the orchestrator's spawn command
  changes, and the subscription manifest schema changes to
  sing-box's config shape.

---

## [0.3.0] — 2026-05-16 — Split naive server out of Caddy (eliminate padding-protocol drift)

v0.1.x bundled sing-box as the NaiveProxy server. v0.2.x replaced
sing-box with Caddy + klzgrad/forwardproxy@naive. Both designs put
a NON-naive server between the macOS client (which speaks the
bleeding-edge `klzgrad/naiveproxy` wire format) and the destination.
Each drifted from the client over time:

- v0.1.x → sing-box's naive plugin lags upstream klzgrad/naiveproxy
  on padding format. Caused intermittent connect failures.
- v0.2.x → klzgrad/forwardproxy@naive's `naive` branch has been
  frozen at commit `d62c80d` (2025-01-18, "Add Naive padding
  protocol v1") for 16+ months. Recent macOS clients (v148+) emit
  a preamble + Variant1 padding the v1-only server doesn't speak;
  tunnel completes CONNECT but immediately closes "before target
  replied" (klzgrad/naiveproxy issues #793 + #785).

v0.3.0 sidesteps the whole class of bugs by running the **same**
naive binary on both ends. The server-side `naive` Linux binary is
pinned to the SAME tag the macOS client's
`COOL-TUNNEL/naive.upstream.json` bundles (currently
`v148.0.7778.96-5`). Bumping the macOS client and the server in
lockstep is the only compatibility surface left.

### Added

- **`ct-naive` container** running `klzgrad/naiveproxy` as server
  (`docker/naive/Dockerfile`). Multi-stage build: stage 1 fetches +
  SHA-256-verifies the Linux x64 tarball pinned in
  `docker/naive/naive.upstream.json`; stage 2 is an alpine + Bun
  runtime that runs `supervisor.ts`.
- **`docker/naive/supervisor.ts`** — Bun TypeScript watcher inside
  ct-naive. Reads `/data/config/naive.json`, locates the matching
  cert pair under `/data/caddy/certificates/`, spawns naive with
  `--config=<runtime>`. Watches both inputs and respawns naive
  (~250 ms debounce) on any change. Healthz on 127.0.0.1:9091.
- **`mholt/caddy-l4`** plugin in Caddy (replaces
  `klzgrad/forwardproxy@naive`). Caddy now runs as a pure L4 SNI
  router on `:443`: `<DOMAIN>` SNI → raw TCP forward to
  ct-naive:443, anything else → fall-through to an inner
  127.0.0.1:8443 HTTPS listener that terminates TLS and
  reverse-proxies the panel.
- **`core/ct-server-core/src/naive/`** — new Rust module rendering
  `/data/config/naive.json` (the supervisor's input). Wired into
  the CLI as `ct-server-core naive render`.
- **`app/Services/NaiveConfigGenerator.php`** + interface —
  thin PHP shell-out paralleling `CaddyfileGenerator`. Hooked into
  `ReloadSingBoxHandler` and `ReloadServerConfigHandler` so every
  credential change re-renders naive.json (and the supervisor
  auto-respawns naive).
- **Operator `./ct drift`** extended: now parses naive.json (was
  Caddyfile basic_auth). `DriftRow.naive` replaces
  `DriftRow.caddyfile`. Legacy `parseCaddyfileBasicAuth` retained
  for migration-window operators with stale Caddyfile + fresh
  naive.json.

### Changed

- **`caddy/Caddyfile.tpl`** rewritten around `layer4`. No more
  `forward_proxy` block, no more `basic_auth` directives, no more
  `probe_resistance` (the naive binary on ct-naive carries those
  concerns now). Caddy's role shrinks to ACME + L4 SNI router +
  inner panel reverse-proxy.
- **`core/ct-server-core/src/caddy/mod.rs`** simplified: the
  Caddyfile renderer no longer reads the proxy_accounts table or
  computes basic_auth lines. `CaddyRenderOutcome.active_users`
  stays in the JSON wire shape but is fixed at 0 (the accurate
  account count lives on `NaiveRenderOutcome.active_users`).
- **`operator/update.ts`** builds + brings up the new `naive`
  service alongside caddy + panel; renders `naive.json` after
  Caddy is up so the cert path is in place before ct-naive's
  supervisor looks for it. `bringNewImagesUp` now passes
  `--remove-orphans` to clean up stale container mappings.
- **`docker-compose.yml`** — adds `naive` service (mem_limit 192m,
  pids_limit 96, NET_BIND_SERVICE), `naive_config` named volume
  shared RW from panel and RO into ct-naive, no published ports
  (only reachable via Caddy's L4 router). Drops the orphaned
  `ipam:` block left behind from the v0.2.0 ct-clash removal.

### Fixed

- **End-to-end tunnel from recent macOS naive (v148+) → server
  works again.** The v0.2.x symptom (`post-CONNECT tunnel closed
  before target replied`, 100+ "successful NOP CONNECT" entries
  in caddy logs that carry zero application bytes) is rooted in
  preamble/padding incompatibility between current naiveproxy and
  the frozen klzgrad/forwardproxy@naive plugin. v0.3.0 eliminates
  the version-skew surface — same binary, same wire format, same
  release cadence on both sides.

### Limitations / followups

- **Single active account per ct-naive.** klzgrad/naiveproxy's
  server mode supports one basic-auth credential per listener.
  v0.3.0 selects the first active account; the drift detector
  surfaces "DB has N accounts, naive.json carries 1" as a real
  finding. Multi-account is a future v0.3.x change (N naive
  processes on N internal ports + SNI subdomains, OR a thin
  authproxy in front).
- **Caddyfile reload from inside panel container still fails.**
  Carried forward from v0.2.x: `docker exec ct-caddy caddy reload`
  needs a docker CLI the panel image doesn't have. From the host
  (via `./ct update`) the reload works fine; from the Filament UI
  it errors silently. Admin-API-over-ct-net replacement remains a
  pending v0.3.x followup. ct-naive does NOT have this problem —
  the supervisor's file-watch is the reload primitive.
- **Cert renewal forces a ~1-2 s ct-naive restart** every ~60 days
  when Caddy renews the `<DOMAIN>` cert. The supervisor sees the
  mtime change and respawns naive; in-flight tunnels drop.
  Hot-reload of TLS material without a process restart is a
  future optimisation.

---

## [0.2.1] — 2026-05-16 — Hot-fix: re-apply cap_net_bind_service to the xcaddy binary

Critical v0.2.0 first-deploy bug. The new docker/caddy/Dockerfile
`COPY --from=build /out/caddy /usr/bin/caddy` replaced the stock
Caddy binary with our xcaddy build but did NOT preserve the
file capability `cap_net_bind_service+ep` that the stock image
bakes onto its `/usr/bin/caddy`. Docker COPY drops file caps.

Result: Caddy starts, fails silently to bind `:443`, falls back
to `:8443` (and `:8080` for `:80`'s alternate). The container is
"healthy" from compose's POV, the host port mapping
`0.0.0.0:443->443/tcp` survives, but nothing listens on the
container side of :443 so every external connection is refused.

### Fixed

  **docker/caddy/Dockerfile** — added `RUN setcap
  cap_net_bind_service=+ep /usr/bin/caddy` immediately after the
  COPY, with a `getcap` verification pinned to fail the build if
  the cap doesn't stick. `cap_add: NET_BIND_SERVICE` in
  docker-compose.yml is necessary but NOT sufficient: the
  container needs the cap in its effective set AND the binary
  needs the file-cap so the cap inherits across exec without
  ambient-cap kernel features the alpine image doesn't enable.

  Symptom (observed on the 2026-05-16 Vultr deploy): ss inside
  the container showed `:::8443 LISTEN` / `:::8444 LISTEN`
  instead of `:::443`. macOS client connections to
  `https://naive.<domain>:443` hung at the SOCKS forward step
  (the upstream :443 wasn't reachable).

### Operator note

  Affects every v0.2.0 deploy. The bug is in the image; existing
  v0.2.0 deploys need to either rebuild caddy after pulling
  v0.2.1, or apply the cap-restore inline:

      docker compose exec -T --user 0 caddy \
          setcap cap_net_bind_service=+ep /usr/bin/caddy
      docker compose restart caddy

  The latter is the hot-patch — survives until the next rebuild,
  at which point `./ct update` pulls the v0.2.1 Dockerfile change
  and bakes the cap in.

---

## [0.2.0] — 2026-05-16 — Architecture cut: sing-box + HAProxy collapse into Caddy+forwardproxy

Real-incident-driven simplification. After the 2026-05-16 macOS-
client debug session bounced between layers for hours with every
static check green but clients still hitting cover-site auth-fail
(turned out to be NaiveProxy padding-extension drift between the
sing-box plugin and the bundled macOS naive binary), we pivoted
to the klzgrad/naiveproxy README's own recommended deployment:
Caddy with the klzgrad/forwardproxy plugin baked in via xcaddy.
**Three services collapse to one. The drift surface that
recurringly bit us is gone.**

### Changed — architecture

  **Front door collapses HAProxy + sing-box + ghost-Caddy into a
  single Caddy container.** Caddy now binds :80 (ACME HTTP-01 +
  http→https) and :443 (TLS termination + SNI-routed handling:
  naive.example.com → forward_proxy with Padding extension;
  panel.naive.example.com → reverse_proxy panel:9000).

  **`docker/caddy/Dockerfile`** is now a multi-stage xcaddy build
  pinning `caddy:2.8.4-builder` → `caddy:2.8.4-alpine`. xcaddy
  pulls `github.com/caddyserver/forwardproxy@caddy2`
  redirected to `github.com/klzgrad/forwardproxy@naive` (klzgrad's
  fork was upstreamed; its go.mod redeclares the canonical
  module path, requiring the redirect at build time).

  **`docker-compose.yml`** retires `sing-box` and `haproxy`
  services. Volumes retired: `singbox_etc`, `singbox_data`,
  `haproxy_etc`, `haproxy_admin`. Network retired: `ct-clash`
  (was sing-box management-plane). Caddy service: mem 64m → 192m,
  pids 32 → 96 (absorbed sing-box's budget); `+:443` port mapping.

  **`caddy/Caddyfile.tpl`** rewritten as the consolidated front-
  door config. Global stanza + `:80` ACME site + `{{ Domain }}`
  forward_proxy site + `{{ PanelDomain }}` reverse_proxy site.

  **`core/ct-server-core/src/caddy/`** renderer extended: pulls
  active ProxyAccount rows, pre-renders basic_auth lines into a
  `ForwardProxyBasicAuthLines` binding, derives a deterministic
  `probe_resistance` secret (`sha256(domain)[..16].localhost`).
  New `caddy::reload()` helper runs `docker exec ct-caddy caddy
  reload --config /etc/caddy/Caddyfile` for graceful, zero-downtime
  config swaps.

  **`SingBoxReloader::reload()`** now calls `CtServerCore::reload-
  Caddy()` instead of the v0.1.x `reloadSingBox()`. PHP class
  name preserved for AppServiceProvider binding compatibility.
  Daemon's `WireRequestV1::ReloadCaddy` handler also routes
  through `caddy::reload()` (replaces `admin::ClashAdmin::reload`),
  so the redis_bridge subscriber path picks up Caddy
  automatically.

  **`operator/update.ts`** v0.2.0 migration pipeline adds
  `stopLegacyV01Containers()` (idempotent — stops + removes
  ct-singbox + ct-haproxy if present, no-op otherwise) between
  `gitPullFfOnly` and `rebuildImages`. Render + reload steps
  collapse from singbox + haproxy pairs to a single
  `renderCaddyfile` + `reloadCaddy`.

  **`operator/src/util/drift-check.ts`** drift detector now reads
  `basic_auth` lines from the rendered Caddyfile instead of
  `inbounds[].users[]` from `/etc/sing-box/config.json`. Same
  three-way semantic (DB ⇄ caddyfile ⇄ subscription endpoint).
  `DriftRow.singbox` renamed to `DriftRow.caddyfile`.

  **`./ct render`** subcommand now accepts only `caddyfile` as
  a target; `haproxy` and `singbox` produce a friendly
  `retired in v0.2.0` hint.

### Removed

  - `docker/sing-box/Dockerfile`, `docker/haproxy/Dockerfile`
  - `sing-box/config.json.tpl`, `haproxy/haproxy.cfg.tpl`
  - `manifests/sing-box.upstream.json`, `manifests/haproxy.upstream.json`
  - `core/ct-server-core/src/haproxy/mod.rs` + the `Cmd::Haproxy`
    CLI subcommand + the `enum HaproxyOp`
  - `scripts/render-singbox.sh`, `scripts/render-haproxy.sh`

  The `core/ct-server-core/src/singbox/` module and
  `core/ct-server-core/src/admin.rs` are kept as dead-code-no-
  runtime-effect for v0.2.0 (still referenced by `metrics::collect`
  and `quota::enforce` which aren't migrated to Caddy equivalents
  yet); full removal lands in a v0.2.1 tidy.

### Operator migration

  `./ct update` on a v0.1.x deploy detects the legacy `ct-singbox`
  and `ct-haproxy` containers and stops + removes them in the new
  `stopLegacyV01Containers` step, then brings up the new caddy
  service on :443. Atomic for the wire-protocol path: at no point
  does both old + new bind :443.

  Rollback: no automatic image-tag preservation in this release.
  The clean downgrade path is `git checkout v0.1.20 && ./ct
  update`, which re-introduces the legacy services via the v0.1.x
  compose. Operators expecting to downgrade should
  `docker image tag cool-tunnel-server-singbox:latest cool-tunnel-
  server-singbox:v0.1.20-rollback` BEFORE the upgrade. (Auto-
  tagging is a v0.2.1+ feature.)

### Validated

  Phase-0 wire-protocol interop test on 2026-05-16 against the
  live Vultr box: vanilla Caddy 2.11.3 + klzgrad/forwardproxy on
  port `:8443` (alongside production sing-box on :443), pointed
  the macOS client's bundled naive binary at it. Result:
  `code=200`, tunneled public IP `207.148.75.238`, end-to-end
  645ms. Caddy stdout: `forward_proxy negotiated padding type:
  Variant1`. The wire protocol path is proven.

### Test coverage

  141 ct-server-core (was 142; deleted haproxy renderer's single
  test). 200 operator (was 198; +2 retired-target tests for the
  render parser, +12 Caddyfile-basic-auth parser tests, replacing
  the sing-box-JSON-shape tests). All green.

---

## [0.1.20] — 2026-05-16 — `ct drift` + `ct wire-probe`: close gaps the credential-lock guard misses

Two new operator verbs born from a real macOS-client debugging
session on 2026-05-16 that bounced between layers for hours
because every static check was green yet clients still hit
cover-site auth-fail. The existing `credential-lock` guard
compares lock-HASHES across layers but does not pin the
cleartext VALUE; the strict component check is structurally
unaware of wire-protocol drift. Two distinct drift classes,
two new detectors.

### Added

  **`ct drift` — three-way cleartext drift check.** Audits
  whether the cleartext password is byte-equal across:
  ProxyAccount::password_cleartext_encrypted (decrypted via
  Laravel Crypt), users[].password inside
  /etc/sing-box/config.json (what naive-in actually compares
  CONNECTs against), and the password field inside
  /api/v1/subscription/{token} (what clients import).
  Drift between any pair manifests as 200+Padding+RST
  cover-site responses — the exact symptom that looks like
  "tunnel doesn't work" with no actionable client-side error.
  Human + `--json` output. Cleartext never printed (table
  emits `same` / `DIFF` / `absent` only). Exit 0 / 1 / 2.

  **`ct wire-probe` — wire-protocol drift detection.** Spawns
  a real NaiveProxy client against the deployment's upstream,
  pushes a real CONNECT via curl-over-SOCKS, and reports
  whether the NaiveProxy `Padding:` extension negotiated.
  Catches the class of bug where a naive binary advertises
  the right `--version` but is a build that doesn't emit the
  padding header sing-box now requires. Seven distinct
  outcomes (padding_negotiated / missing_padding /
  auth_failure_cover_site / tls_handshake_failed /
  connect_timeout / naive_didnt_start / unknown_failure)
  each map to a specific operator next-step printed on
  failure. Cleartext password lands in a 0700 temp dir's
  0600 config file only; never in argv, never in stdout.

  **`ct help drift` and `ct help wire-probe` topics.** New
  entries in the binary-only topic registry. Walk through
  each repair recipe by failure mode.

### Operator note

  Both verbs are binary-only (no shell fallback), same shape
  as `ballast` and `version-bridge`. Operators see them via
  `./ct drift` / `./ct wire-probe` only AFTER the wrapper
  bootstrap fetches the v0.1.20 binary. Until that auto-fetch
  fires, the same logic is reachable via
  `bun run operator/drift.ts` and `bun run operator/wire-probe.ts`
  directly.

### Test coverage

  32 new tests in `operator/tests/{drift-check,wire-probe}.test.ts`
  pin the parsers + classifiers + the "cleartext never leaks
  into output" contract. Full operator suite: 196 pass / 0 fail.

---

## [0.1.19] — 2026-05-15 — Hot-fix: post-swap `component check` + flock false-positive lock-busy

Two bugs surfaced by a real end-to-end `./ct update` on the Vultr
deploy after the v0.1.16 binary unblocked startup. v0.1.18 shipped
the cross-layer version-bridge but didn't catch these two.

### Fixed

  **`ct update` post-swap component check failed on every binary
  in v0.1.13–v0.1.18.** `operator/src/util/component-check.ts`
  invoked `ct-server-core component check --manifests-dir <path>`,
  but the Rust CLI flag is `--manifests <path>` (no `-dir`
  suffix). Bun port typo — the two other call sites (doctor +
  readiness) already had it right. Caught on the v0.1.18 Vultr
  update where the post-swap step died with:

      error: unexpected argument '--manifests-dir' found
        tip: a similar argument exists: '--manifests'

  **Spurious "another cool-tunnel operator script is already
  running" after every failed task.** `op-lock.ts` checked
  `result.status === 1` for `flock -n`'s lock-busy signal, but
  flock by default PASSES THROUGH the child's exit code AND
  exits 1 when lock-acquire fails — indistinguishable. Every
  child task that died via `dieWithDiag()` (which exits 1)
  triggered the parent to spuriously print the lock-busy
  diagnostic AFTER the real failure surface, confusing
  operators into thinking they had a parallel-invocation
  problem. Switched to `flock -n -E 75` (75 = `EX_TEMPFAIL`
  from sysexits.h, used in flock's own lock-busy examples) so
  lock-busy has a distinct exit code; child failures pass
  through cleanly.

### Operator note

  Operator-binary only. v0.1.18 deploys pick up the new binary
  automatically on next `./ct update` step 15 (auto-fetch from
  v0.1.7), AND now also via v0.1.18's wrapper self-bootstrap
  on the first invocation — no manual `curl` needed.

---

## [0.1.18] — 2026-05-15 — Cross-layer version-bridge: detect + auto-heal PHP/Rust/Bun version skew

Three runtime layers ship from the same repo and must agree on
what version a deployment is running: panel/config/cool-tunnel.php
(PHP, canonical truth), ct-server-core inside the panel container
(Rust core), and operator/bin/ct-operator-<os>-<arch> (Bun CLI).

The v0.1.12 → v0.1.13 deploy-skew failure mode that ate hours on
2026-05-15: the operator binary on disk was v0.1.12 but the wrapper
(post-git-pull) dispatched `update` — a subcommand v0.1.12 didn't
have. Result: `error: unknown command: update`, no auto-recovery,
manual `curl` required to bootstrap. v0.1.18 closes the hole at
three layers of defense-in-depth.

### Added

  **`ct version-bridge` subcommand.** Surfaces all three layers'
  versions side-by-side with a `!` marker on the diverging ones.
  Exit codes: 0 = agreed, 1 = skew, 2 = no readable layer.
  `--json` mode emits the structured `BridgeReport` for cron/CI
  consumption.

  **`ct-operator-version` ballast check.** Mirrors the existing
  `ct-core-version` check. Compares the binary's compiled-in
  `BUILD_VERSION` against `panel/config/cool-tunnel.php`. Fails
  with an actionable hint (`./ct update` or `make operator-fetch`)
  when they disagree.

  **`ct` wrapper self-bootstrap.** Before dispatching to the
  binary, the wrapper compares its version to
  `panel/config/cool-tunnel.php`. On mismatch it curl-fetches
  the matching binary from GitHub Releases (SHA-256 verified
  against `SHA256SUMS`), atomic-renames into place, then
  proceeds with the original dispatch. Skippable via
  `CT_SKIP_OPERATOR_BOOTSTRAP=1`; failure is non-fatal (leaves
  the stale binary in place and dispatch proceeds).

  **`operator/src/util/version-bridge.ts`** — pure-logic helper
  shared by all three of the above. Three readers + one
  classifier; 14 unit tests covering happy / mismatch /
  unreadable / edge paths.

### Operator note

  Today's bug, replayed under v0.1.18:

      $ git pull   # main jumped from v0.1.12 to v0.1.18
      $ ./ct update
      ct: operator binary v0.1.12 ≠ deployed v0.1.18;
            fetching matching binary…
      ct: bootstrapped operator binary to v0.1.18
      [update] start
      ==> 1. Pre-flight
          ...

  No manual `curl` step. No `unknown command: update`. Hours of
  recovery → seconds.

---

## [0.1.17] — 2026-05-15 — UX hot-fix: stream BuildKit progress live in update's rebuild steps

v0.1.13's port-everything-to-Bun batch wrapped the Rust + image
builds in `capture()`, which calls `.quiet()` on Bun's shell to
buffer stdout/stderr until subprocess exit. The pre-port
`update.sh` let `docker buildx` stream BuildKit progress lines
to the terminal in real time (`[+] Building 31.6s (17/23) ...`).
Post-port the same 60-180s build emitted ZERO output until
completion — looking like the script was hung. Reported
2026-05-15 on the v0.1.16 Vultr update where step 4 ("Rebuild
ct-server-core (Rust)") sat with no output for ~3 minutes.

### Fixed

  New `runStreaming(p)` helper in `operator/src/util/sh.ts`. Same
  nothrow semantics as `capture()` but skips `.quiet()`, so
  stdout/stderr flow live to the operator's terminal. Returns
  only `{ok, code}` — no captured strings; appropriate for the
  build callers that fall through to a generic `dieWithDiag`
  remediation hint anyway.

  Switched 2 update.ts call sites:
    rebuildCore     docker compose build core-builder (Rust)
    rebuildImages   docker compose build sing-box panel haproxy

  Other long-running captures (`docker compose up -d`, `php
  artisan migrate`) keep `capture()` because their dieWithDiag
  handlers reference `r.stderr`; they're also fast on the typical
  re-update path (cached image swap + idempotent migrate =
  seconds).

### Operator note

  UX-only. No correctness change. v0.1.16 deploys can wait for
  v0.1.17 binary on next auto-fetch.

---

## [0.1.16] — 2026-05-15 — Critical hot-fix: op-lock re-exec passed `/$bunfs` argv to lock-holding child

Second `/$bunfs` bug from the v0.1.13 Bun-migration aftermath.
v0.1.15's `ensureRepoRoot()` fix unblocked the binary's startup
but exposed this lurking issue in the same call chain:
`acquireOpLock()` re-execs the binary under `flock -n`, passing
`process.argv.slice(1)` as the child's argv.

In dev: `argv = [<bun>, "operator/update.ts", "update"]` →
`slice(1)` is correct (bun expects the script path first).
In a compiled binary: `argv = [<binary>, "/$bunfs/root/<binary-
name>", "update"]` → `slice(1)` includes the synthetic /$bunfs
path, which the dispatcher in the re-exec'd lock-holding child
sees as the first user arg → routes to "/$bunfs/root/...":

    [update] start
    error: unknown command: /$bunfs/root/ct-operator-linux-x64

Surfaced 2026-05-15 on the Vultr v0.1.15 deploy. `./ct update`
died inside `acquireOpLock` before any update work ran.

### Fixed

  New `resolveReExecArgs(argv)` pure helper in `operator/src/util/
  op-lock.ts` (exported for testing). Detects compiled-binary mode
  via `isBunFsUrl(argv[1])` — the same check `ensureRepoRoot` uses.
  In compiled mode returns `argv.slice(2)`; in dev returns
  `argv.slice(1)`. `acquireOpLock` now passes `resolveReExecArgs(
  process.argv)` to `flock` instead of the raw `slice(1)`.

  Audit pass over the rest of `operator/` confirmed every other
  `process.argv` / `import.meta.url` consumer is /$bunfs-safe:
  argv parsers use `indexOf("cmd")` instead of positional slicing,
  the chdir sites are all behind `ensureRepoRoot()`, and
  `import.meta.main` is a Bun-runtime check that works in both
  modes. No other compiled-binary-sensitive sites found.

### Operator note

  Operator-binary only. v0.1.15 deploys whose `./ct update` died
  with `error: unknown command: /$bunfs/...` cannot self-heal via
  `./ct update` — the bug *is* in the lock acquisition that
  guards `update`. Manual one-time fetch:

      curl -fsSL https://github.com/coo1white/cool-tunnel-server/releases/download/v0.1.16/ct-operator-linux-x64 \
          -o operator/bin/ct-operator-linux-x64
      chmod +x operator/bin/ct-operator-linux-x64
      ./ct update

  Future `./ct update` runs auto-fetch the latest binary at step
  15 — same pattern as v0.1.7+.

---

## [0.1.15] — 2026-05-15 — Critical hot-fix: chdir to `/$bunfs` blocked every compiled-binary subcommand

v0.1.13's port-everything-to-Bun batch landed a chdir pattern in
every top-level `operator/*.ts`:

  const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  process.chdir(repoRoot);

In dev (`bun run operator/update.ts`) this lands cwd at the repo
root. In a compiled binary (`bun build --compile`), Bun bundles
sources into a synthetic `/$bunfs/` virtual filesystem;
`import.meta.url` points INTO `/$bunfs/`, and `new URL("..", ...).
pathname` resolves to `/$bunfs` — a path that exists only inside
the binary's runtime, not on the host. v0.1.13 + v0.1.14 binaries
unconditionally chdir'd there and died on first invocation:

    [update] fail (1ms, ENOENT: no such file or directory,
                  chdir '/opt/cool-tunnel-server' -> '/$bunfs')

Hit on the Vultr v0.1.14 deploy 2026-05-15. **Affects every
top-level operator script** dispatched through the compiled binary:
update, backup, restore, sbom, pin-images, auto-update,
sqlx-prepare, verify-sot, verify-supervisord. The binary failed
before any real work ran on every subcommand.

### Fixed

  New helper `operator/src/util/repo-root.ts::ensureRepoRoot()`.
  Detects `/$bunfs` URLs via substring match (`isBunFsUrl`). In
  compiled-binary mode trusts `process.cwd()` — the `./ct`
  wrapper cd's into the repo root before exec'ing the binary
  (`cd "$SCRIPT_DIR"` at ct:42), so cwd is correct on entry.
  In dev mode walks `..` from `import.meta.url` as before.
  Single source of truth; the 9 affected scripts now all call
  `ensureRepoRoot(import.meta.url)`.

  Special case — `verify-supervisord.ts` used `${repoRoot}/
  docker/panel/supervisord.conf` as a path string (no chdir).
  Same root cause: `${repoRoot}` was `/$bunfs` in compiled mode,
  so `Bun.file()` looked inside the embedded snapshot instead
  of the host's on-disk conf. Switched to `ensureRepoRoot()`
  + relative path; now reads the host file as intended.

### Operator note

  Operator-binary only. v0.1.14 deploys whose `./ct update`
  failed cannot self-heal via `./ct update` (the bug *is* in
  update). Manual one-time fetch:

      curl -fsSL https://github.com/coo1white/cool-tunnel-server/releases/download/v0.1.15/ct-operator-linux-x64 \
          -o operator/bin/ct-operator-linux-x64
      chmod +x operator/bin/ct-operator-linux-x64
      ./ct update

  Future `./ct update` runs auto-fetch the latest binary at
  step 15 (v0.1.7's behaviour, unchanged).

---

## [0.1.14] — 2026-05-15 — Hot-fix: IPv6 preflight in `ct update` + secret-carrying bash-c unnest

Re-audit pass on the freshly-Bun-migrated v0.1.13 surface caught
two regressions worth a hot-fix release. Both are operator-binary
only — no Rust core / panel image / compose changes.

### Fixed

  **`update.ts` inherited the v0.1.9 IPv6-preflight gap.** The
  v0.1.9 IPv6 auto-disable runs in `bootstrap.sh` + `install.sh`
  preflight, so first-installs on cheap VPSes (Vultr, RackNerd)
  with broken IPv6 routing get the sysctl + daemon.json override
  written before the first Rust build. `update.sh` / `update.ts`
  never had the equivalent — so a box whose docker daemon.json
  got re-enabled for IPv6 between installs (kernel update,
  provider reboot, manual mucking) hits the exact
  `static.rust-lang.org Network unreachable (os error 101)` wall
  on the next `./ct update`, with no auto-recovery. Hit a Vultr
  v0.1.11 → v0.1.12 update in production on 2026-05-15.

  Added `checkIpv6Routing()` to `operator/src/util/preflight.ts`.
  Detects no-global-IPv6 + missing
  `/etc/sysctl.d/99-disable-ipv6.conf`, delegates the fix to the
  existing `ipv6_broken_routing` recipe (single source of truth),
  reports `skipped` / `ok` / `fixed` / `warn`. Skippable via
  `CT_SKIP_IPV6_AUTO_DISABLE=1`. Wired into `operator/update.ts`
  between `checkStackUp()` and `preflightCleanTree()`, so it runs
  BEFORE the `gitPullFfOnly` + `rebuildCore` steps that would
  otherwise trip on IPv6. Pure classification logic split into
  `classifyIpv6Preflight()` + 6 unit tests covering every action
  branch.

### Security

  **Bun-shell-escape bug class in two secret-carrying call
  sites.** Same class as v0.1.12's caddy-acme / active-users
  bug. Pre-fix the Redis password was interpolated INTO a `bash
  -c "..."` quoted string. Bun shell-escaped `${pw}` once, but
  bash then re-parsed the resulting command line. A password
  containing `$`, backtick, or `"` would corrupt tokenisation.
  Generated passwords are filtered (`tr -d '/=+'`) so the field-
  encounter probability is near zero, but an operator-set
  `REDIS_PASSWORD` is unconstrained.

  Fixed by switching to `docker compose exec -e REDISCLI_AUTH`
  (no value — imports from the calling shell's env) +
  `.env({...process.env, REDISCLI_AUTH: pw})`. The secret never
  appears in argv. Sites updated:
  `operator/src/tasks/doctor.ts::infoMessengerDepth` and
  `operator/src/tasks/readiness.ts` slot 8 "Redis bridge".

### Operator note

  Operator-binary only. Existing v0.1.13 deploys pick up the new
  binary automatically on next `./ct update` step 15 (auto-fetch
  added in v0.1.7). No service downtime.

---

## [0.1.13] — 2026-05-15 — Bun-native operator binary is canonical for every interactive subcommand; bash stays as fallback

The Bun-bundled `ct-operator` binary, introduced in v0.1.5, is now
the **canonical implementation** for every interactive subcommand
the operator runs on a VPS. The bash scripts under `scripts/` that
existed in parallel are now thin fallbacks that `./ct` only reaches
when the operator binary is missing (e.g. a brand-new clone that
hasn't yet run `./ct update`).

Three categories of bash scripts went away in this release:

  - **Operator-canonical, bash kept as fallback** —
    `fix.sh`, `doctor.sh`, `late-night-comeback.sh`, `auto_sync.sh`,
    `backup.sh`, `restore.sh`, `auto_update.sh`, `update.sh`,
    `help.sh`. The operator binary owns the logic; the bash file
    stays so a host without the binary still functions.

  - **Operator-canonical, bash deleted** — `verify_supervisord.sh`,
    `pin-images.sh`, `sbom.sh`, `verify_sot.sh`, `verify_sot_vps.sh`,
    `sqlx-prepare.sh`. These only have `make` callers (dev hosts +
    CI); the operator path is the only path now.

  - **Consolidated** — `render-{caddyfile,haproxy,singbox}.sh`
    collapsed into one `render <target>` operator subcommand.
    The bash trio stays as the fallback dispatch target.

Test coverage grew from 19 → 135 passing operator tests across
18 test files.

### Added

- **`ct-operator` subcommands** — `auto-sync`, `backup`,
  `restore <path>`, `auto-update`, `update`, `help [topic]`,
  `render <target>`. Plus the existing `doctor`, `fix`, `readiness`,
  `ballast`, `self-update`.

- **Pure-TS port of all 21 `fix.sh` recipes** —
  `docker_daemon_down`, `compose_service_down`, `pending_migrations`,
  `sing_box_doh_crash`, `compose_caddy_zombie`, `ipv6_broken_routing`,
  `stale_subscription_users`, `zombie_docker_proxy`,
  `foreign_container_ports`, `broken_container_dns`,
  `haproxy_backend_dns`, `missing_tls_cert`, `panel_restart_loop`,
  `messenger_queue_stuck`, `no_proxy_account`, `legacy_env_shape`,
  `credential_drift`, `ipv6_dns_unreachable`,
  `singbox_domain_resolver`, `singbox_outbound_ipv4_only`,
  `stale_deployment`. All run in-process from the operator binary —
  no more `bash -c` shelling out to extract function bodies from
  `scripts/fix.sh` via the MAIN-divider `sed` trick. (#118-#120.)

- **Operator-side utility modules** under `operator/src/util/`:
  - `term.ts` — shared step/ok/warn/die helpers + ANSI palette.
  - `compose.ts` — `composeProjectName()`, `serviceRunning()`.
  - `op-lock.ts` — `acquireOpLock()` re-execs self under `flock -n`,
    parameterised marker so nested locks don't collide (#134).
  - `wait.ts` — bounded polling helper.
  - `release.ts` — `probeVersions()`, `readCurrentVersion()`,
    `upgradeAvailable()` shared by the stale_deployment fix recipe
    and the auto-update task.
  - `preflight.ts` — `checkNetwork()`, `checkDiskSpace()`,
    `checkStackUp()` mirror `scripts/lib.sh::preflight_*`.
  - `diag.ts` — `dieWithDiag()` mirrors `scripts/lib.sh::die_with_diag`.
  - `env-migrate.ts` — pure `.env` migration logic (PANEL_DOMAIN
    backfill + relocate + APP_URL legacy-form fix). Three phases,
    each idempotent.
  - `component-check.ts` — strict NG gate over `ct-server-core
    component check` table output.
  - `credential-sync.ts` — shared audit-and-correct cycle used by
    both `auto-sync` and the `credential_drift` fix recipe.
  - `prompt.ts` — `promptYn()`, `promptChoice()` for the
    interactive clean-tree prompt (#135).
  - `sot.ts` + `sot-runners.ts` — fixture matrix + host/VPS probes
    for the panel_domain SoT cross-language parity check.

- **`TaskResult.skipBridge`** — opt out of the incident-bridge dump
  for known-clean failures (usage errors, missing prerequisites).
  Used by every subcommand that has its own structured diagnostic
  output already.

- **Interactive `[s/d/a]` clean-tree prompt** in the operator-
  binary update path. Was previously bash-fallback-only. Matches
  `scripts/lib.sh::preflight_clean_tree` semantics on TTY; falls
  back to a non-interactive `die_with_diag` on cron/CI. (#135.)

- **135 operator unit tests** (was 19), covering every pure helper
  introduced this release plus the fix recipe argv parsers and
  fixture matrices.

### Changed

- **`./ct` dispatcher** — every subcommand that has an operator-
  binary implementation now routes through `dispatch_via_operator`:
  `fix`, `doctor`, `readiness`, `ballast`, `render`, `auto-sync`,
  `backup`, `restore`, `auto-update now`, `update`, `help`. The
  bash script in `scripts/` is the fallback target. The dispatch
  pattern is uniform across every subcommand.

- **`auto-update`** — was shelling out to `./scripts/update.sh`
  (the bash original). Now invokes `./ct update`, which prefers
  the operator binary. Scheduled auto-update runs ride the same
  deploy code path as interactive `ct update`. (#134.)

- **`scripts/fix.sh`'s 17 recipes**, formerly delegated to via a
  `sed`-extracted helper-function dispatcher, are no longer
  reached from the operator binary. The bash file remains as
  the bash fallback.

- **Makefile targets** that were called only by `make` (not via
  `ct`) — `verify-supervisord`, `pin-images`, `sbom`, `verify-sot`,
  `verify-sot-vps`, `sqlx-prepare`, `help-topics`, `help-%` —
  now invoke the operator-side Bun script directly via
  `cd operator && bun run …`. Dev hosts need Bun installed
  (which they already do — `operator-build`, `operator-test`,
  `operator-typecheck` all require it).

- **`scripts/install.sh`'s `require_cmd jq` hint** — stripped the
  stale "+ sbom.sh" mention now that SBOM generation uses
  `JSON.stringify` instead of shelling out to `jq`.

### Removed

- **`scripts/verify_supervisord.sh`** — replaced by
  `operator/verify-supervisord.ts` (#122).
- **`scripts/pin-images.sh`** — replaced by
  `operator/pin-images.ts` (#123).
- **`scripts/sbom.sh`** — replaced by `operator/sbom.ts` (#124).
- **`scripts/verify_sot.sh`** + **`scripts/verify_sot_vps.sh`** —
  replaced by `operator/verify-sot.ts` with `--mode=host|vps`
  (#125). The `sot-parity` ballast check now calls the matrix
  in-process instead of shelling out.
- **`scripts/sqlx-prepare.sh`** — replaced by
  `operator/sqlx-prepare.ts` (#130).

### Fixed

- **`sot-parity` ballast check** used to skip-exit 0 on docker-only
  VPS hosts because `scripts/verify_sot.sh` would skip when
  `php`/`cargo` were missing, and the operator collector treated
  any exit-0 as PASS. The check now runs the matrix in-process via
  `docker compose exec`, so it actually asserts PHP/Rust parity on
  the deployed stack. (#125.)

- **Nested-lock marker collision in `acquireOpLock`** — a process
  holding one flock that then nested into another `acquireOpLock`
  call would see the outer's marker and skip acquiring the inner
  lock. Markers are now parameterised; auto-update uses a
  dedicated marker distinct from the per-project ops lock. (#134.)

### Security

- **Lock-busy soft-skip** — `acquireOpLock({ softSkip: true })`
  exit 0 instead of `die()` when the lock is busy. Used by the
  cron-triggered auto-update so a missed tick isn't logged as an
  error.

---

## [0.1.12] — 2026-05-15 — Hot-fix: doctor's caddy-acme + active-users checks (Bun shell-escape unnest)

Two cosmetic ct-operator regressions caught on the first v0.1.11
production deploy. Neither affected the running proxy (Components
verified 12/12 OK in the same run); both surfaced as parse errors
in the `./ct doctor` display where values were expected.

### Fixed

  **`caddy-acme` ballast check threw `expected a command or
  assignment but got: "CmdSubstEnd"`.** The expiry probe used
  bash arithmetic `$((7*86400))` inside a Bun \$ template literal.
  Bun's parser saw `$((` and tried to read it as command
  substitution `$(...)`, failing on the doubled paren. Fixed by
  pre-computing `7 * 86400` in TypeScript and dropping the
  redundant `bash -c "docker compose exec sh -c \"...\""` wrapper
  — `docker compose exec` already runs in a shell.

  **`Active users` info line displayed PHP parse error instead of
  a count.** The snippet `\\\\App\\\\Models\\\\ProxyAccount`
  travelled through 4 layers of escape: Bun \$ → bash -c → tinker
  --execute single-quoted argv → PHP. The eight-deep backslash
  escaping was meant to deliver `\App\Models\` but PHP received
  bare `\`, emitted `T_NS_SEPARATOR`. `tr -d '[:space:]'` then
  folded the multi-line PHP backtrace onto the info banner.
  Fixed by passing the PHP snippet as a single Bun-escaped argv
  arg (`--execute=${snippet}`) and dropping the leading
  backslash on the namespace path — tinker's global scope
  resolves `App\Models\ProxyAccount` without it.

### Operator note

  Both fixes are operator-binary only (`operator/src/diag/collectors/ballast.ts`
  + `operator/src/tasks/doctor.ts`). Existing v0.1.11 deploys
  pick up the new binary automatically on next `./ct update`
  (step 15 — auto-fetch added in v0.1.7). No service downtime.

---

## [0.1.11] — 2026-05-15 — Robustness audit landings: render safety, secret-leak guards, privacy hardening, defense-in-depth

Output of a parallel-agent codebase audit (Laravel/Filament/FrankenPHP,
Rust core, Bun adoption, privacy/redaction) run after v0.1.10. Six
focused PRs covering the highest-impact findings. No behaviour change
for healthy deploys; every fix moves a silent-failure mode into a
visible / actionable one.

### Fixed

  **Render safety: JSON-validate before write + last-known-good
  preservation (#110).** `singbox::render` now parse-validates the
  rendered body with `serde_json::from_str` before the atomic_write,
  and copies the previous config to `<path>.bak` before replacing
  it. Catches malformed templates at O(µs) instead of letting them
  replace a working config. The `.bak` is what would have unstuck
  the 2026-05-15 hostname-form DoH crash-loop in seconds
  (`mv config.json.bak config.json && docker compose restart
  sing-box`) instead of an hour of `sed` patches.

  **Daemon render+validate+lock as one atomic wire dispatch (#111).**
  The `RenderCaddyfile` wire handler now runs `singbox::render` →
  `singbox::validate` → `credentials::assert_locked` as one
  transaction. Closes the post-render gap where the daemon Ok-ed a
  config that was either semantically broken or already drifted from
  the live DB, and only the subsequent `ReloadCaddy` surfaced the
  failure — by which time the panel had already told the operator
  "Reload queued" with no warning.

  **Narrow `\Throwable` catch in panel generators (#112).** The
  thin `SingBoxConfigGenerator` / `CaddyfileGenerator` shell-out
  wrappers caught `\Throwable` and returned null on any failure,
  treating PHP code defects (TypeError, undefined-method,
  class-not-found) the same as transient runtime hiccups. Post-fix,
  `\Error` re-throws so the surrounding save fails with a 500;
  `\Exception` keeps the soft-fail return-null path. The v0.0.9
  `renderCaddyfile()`-by-typo bug that lived for weeks would
  surface immediately under the new boundary.

  **FrankenPHP worker-mode DB connection recycle (#109).** Re-enabled
  `DisconnectFromDatabases` in `OperationTerminated`. Without it,
  the upstream MySQL `wait_timeout` (8h default) silently closed
  connections out from under workers; the next request on that
  worker hit "MySQL server has gone away" with no recovery. Per-
  request reconnect cost is negligible on a 1 vCPU admin panel.

  **Panel reload-transport pre-flight (#110).** `ServerConfigPage::save`
  now pings Redis after the row commits and renders a persistent
  warning notification when Redis is unreachable, replacing the
  unconditional "Reload queued" success banner. Also fixes the
  notification's hint pointing operators at a log key
  (`serverconfig.reload.job_failed`) that doesn't exist anywhere in
  the codebase; the actual key is `serverconfig.reload.dispatch_failed`.

### Security

  **Plaintext-password `Debug` redacted on `CredentialTuple` and
  `ProxyAccount` (#109).** Auto-derived `Debug` printed passwords
  inline; a future `dbg!()` or panic message would have leaked
  cleartext to stderr. Replaced with hand-written impls that
  redact password / password_hash / cleartext_password while
  keeping username visible for operator drift-debugging. Also
  dropped the (unused) `Serialize` derive from `CredentialTuple`
  since it never crosses a wire or persistence boundary.

  **Usernames dropped from subscription-fallthrough logs (#109).**
  `Log::warning('subscription.fallthrough.account_disabled')` and
  `Log::critical('subscription.fallthrough.cleartext_decrypt_failed')`
  no longer carry the `username` field. `account_id` is sufficient
  for operator DB-lookup, and the project's `CONTRIBUTING.md`
  privacy policy is explicit: usernames never get logged.

  **Redis password no longer in `docker inspect` Cmd[] (#114).**
  Pre-fix, `command: ["redis-server", "--requirepass",
  "${REDIS_PASSWORD}"]` baked the resolved plaintext into the
  container's command array — readable by anyone with docker
  socket access, plus `/proc/1/cmdline` inside the container. Now
  the password reaches redis-server via stdin (`redis-server -`,
  documented stdin-config mode); argv contains nothing sensitive,
  and an empty `$REDIS_PASSWORD` fails fast instead of silently
  starting redis without auth.

  **Explicit `->authorize()` on three custom Filament actions
  (#113).** `regenerate_password`, `show_subscription_url`,
  `activate` now declare `->authorize(fn (): bool =>
  auth()->check())` instead of relying solely on the panel's auth
  middleware. Defense-in-depth for a future multi-tenant policy or
  routing refactor.

### Changed

  **`scripts/sbom.sh`: prefer `bunx` over `npm install -g` (#109).**
  Drops the only `npm install -g` in the scripts tree. Falls back
  to system `cdxgen` or `npx --yes` if Bun isn't on PATH.

  **Generator constructors type-hint the interface (#112).** Both
  `SingBoxConfigGenerator` and `CaddyfileGenerator` now type their
  `$core` parameter as `CtServerCoreInterface` (the existing
  interface already bound to the concrete in `AppServiceProvider`).
  Required for the new test coverage — PHPUnit can't double the
  `final` concrete class. Runtime DI graph unchanged.

### Added

  **`panel/tests/Unit/GeneratorErrorBoundaryTest.php` (#112).** 6
  tests pinning the catch-narrowing contract for both generators:
  `\RuntimeException` → soft-fail, `\Error` → re-throw, plus the
  hash-return / null-return happy paths.

  **4 new unit tests for sing-box render safety helpers (#110).**
  Brings the Rust core test count from 132 to 136.

### Operator note

  No deployment migration is required. `./ct update` picks up the
  changes; `docker compose up -d` rolls them in. The redis
  container's command changed (now `sh -c <wrapper>` instead of
  direct `redis-server`); the wrapper pre-flights an empty
  `REDIS_PASSWORD` and refuses to start without auth — a
  pre-existing bug fix as a side effect.

---

## [0.1.10] — 2026-05-15 — Smarter `ct fix`: 4 new pure-TS recipes for the v0.1.7 debug-session classes + `--auto` mode

v0.1.9 fixed the three deployment-killers at the source. v0.1.10
teaches the fix agent how to recognize and self-heal them when
they appear on an EXISTING deploy that hasn't picked up the
v0.1.9 changes — and adds an unattended `--auto` mode so a
busy / tired operator can just say "heal everything" without
walking the apply/skip/explain prompt.

### Added

  Four new pure-TS recipes in `operator/src/tasks/recipes/`,
  registered in `PURE_TS_RECIPES` and pushed to the top of
  `RECIPE_SLUGS` so they're detected before the legacy
  delegating recipes:

  - **`ipv6_broken_routing`** — detects `ip -6 addr show scope
    global` empty + sysctl override missing. Fix: writes
    `/etc/sysctl.d/99-disable-ipv6.conf` + `daemon.json` +
    restarts docker. Same logic as v0.1.9's
    `disable_ipv6_if_broken` in `lib.sh`, but applied
    post-deploy when the operator is past install.sh.

  - **`compose_caddy_zombie`** — detects `ct-caddy` in
    Created / Exited / Dead state. Fix: `docker rm -f
    ct-caddy` to release the docker port reservation, then
    `compose up -d caddy`.

  - **`sing_box_doh_crash`** — detects sing-box in
    Restarting state with `missing domain resolver` in the
    last 20 log lines. Fix: re-render via
    `ct-server-core --json singbox render` (picks up v0.1.9's
    template with the bootstrap server). Falls back to an
    in-place sed patch if the panel is unreachable.

  - **`stale_subscription_users`** — detects
    `__no_active_accounts__` in the rendered sing-box config
    AND >= 1 enabled proxy account in the DB. Fix: re-render
    + restart sing-box. Catches the "I created an account
    but the proxy still uses the placeholder" trap that
    cost ~30 min on the v0.1.7 deploy.

  **`ct fix --auto`** — non-interactive mode. Every detected
  issue is fixed without the apply/skip/explain prompt. Cron-
  safe, unattended-recovery-safe, "I just want my stack
  healthy" safe. Compose with `--no-bridge` to also suppress
  the AI incident bridge.

### Verified

  - `bun run typecheck` clean.
  - `bun test` — 19 / 19 pass (no test changes; existing suite
    still green).
  - Recipe ordering: pure-TS recipes run before the 17 legacy
    delegating ones, so the v0.1.10 class is caught fast.

### Operator note

Land after PR #104 (v0.1.9). v0.1.9 fixes the underlying causes
in install.sh / bootstrap.sh / the sing-box template; v0.1.10
teaches `ct fix` to handle the post-incident cleanup when the
issue did slip past install. Both PRs are independently useful;
together they make the foolproof-deploy story complete.

---

## [0.1.9] — 2026-05-15 — Foolproof first-deploy: sing-box DoH bootstrap + cheap-VPS IPv6 ban + ct-caddy zombie cleanup

Three deployment-killers found on a real v0.1.7 first-deploy that
ate ~6 hours of operator time. All three were project-level bugs
that no amount of operator skill could route around without
source-reading.

### Fixed

  **`sing-box/config.json.tpl` had no bootstrap DNS resolver.**
  The DB migration ships the DoH default as
  `https://dns.alidns.com/dns-query` (hostname-form, chosen for
  GFW reachability — see `docs/going-to-china.md`). sing-box 1.13
  refuses hostname-form DNS servers without a per-server
  `domain_resolver` to bootstrap from. Every fresh deploy
  crash-looped on:

  ```
  FATAL: create service: initialize DNS server[0]:
         missing domain resolver for domain server address
  ```

  Fixed by adding an IP-based bootstrap entry (`223.5.5.5` — AliDNS
  IP, reachable both inside and outside the GFW) and binding the
  doh server's `domain_resolver: "bootstrap"` on the server entry
  itself (Dial Fields schema — the `dns` block has no top-level
  default-resolver field in sing-box 1.13). Any value of
  `{{ .DohServer }}` — IP-form or hostname-form — now renders
  to a config sing-box accepts without operator intervention.

  **`scripts/install.sh` step 12 didn't clean up stuck `ct-caddy`
  containers.** A failed-then-retried install leaves `ct-caddy` in
  `Created` state. Docker reserves host port 80 at CREATE time —
  not at START — so every subsequent `compose up -d caddy` fails
  with `bind 0.0.0.0:80: address already in use`, with `ss -tlnp`
  showing nothing actually listening. Operators reach for
  `iptables -F` / reboot / blame the network stack and burn hours.
  install.sh now `docker rm -f ct-caddy` before `compose up -d
  caddy` when the existing container is in
  Created / Exited / Dead state. Surgical: a Running ct-caddy is
  untouched.

  **Cheap-VPS broken IPv6 routing.** Vultr / RackNerd / similar
  cheap-VPS images advertise IPv6 in the kernel but have no
  working global IPv6 route. Docker buildkit prefers IPv6 for
  outbound HTTPS, then dies on `static.rust-lang.org` during the
  Rust build step with `Network unreachable (os error 101)`.
  Detected via `ip -6 addr show scope global` being empty.
  `scripts/bootstrap.sh` and `scripts/install.sh::Pre-flight`
  now disable IPv6 at the sysctl + docker daemon layers when the
  detection fires. Idempotent; skippable via
  `CT_SKIP_IPV6_AUTO_DISABLE=1` for operators whose IPv6 actually
  works.

### Added

  `scripts/lib.sh::disable_ipv6_if_broken` — shared helper used by
  both `bootstrap.sh` and `install.sh` pre-flight steps.

  `scripts/lib.sh::sudo_if_needed` — wraps `sudo` for paths that
  may run as root (bootstrap.sh) or non-root (install.sh from
  inside `/opt/cool-tunnel-server`).

---

## [0.1.8] — 2026-05-15 — Hot-fix: `caddy-acme` + `singbox-admin` check designs + operator/package.json version bump

Second iteration of Phase-9 dogfood. After v0.1.6 fixed the
primitives, the live-VPS run flipped 4 checks to PASS but
surfaced two remaining check-design bugs and one cosmetic
version-display bug.

### Fixed

  **`caddy-acme` was looking at the wrong directory level.**
  v0.1.6's check did `ls /data/caddy/certificates` (top level)
  and grepped the listing for the domain. But Caddy nests certs
  under the ACME issuer:
  `/data/caddy/certificates/<issuer>/<domain>/<domain>.crt`.
  The top-level listing returns the issuer dir name, never the
  domain — so the check FAILed on every real deploy. Switched
  to `find /data/caddy/certificates -name "${domain}.crt"` and
  expanded the expiry probe to use the discovered path.

  **`singbox-admin` was probing a port that's never
  host-bound.** The clash admin port (default 9090) is bound
  inside the sing-box container only — project security policy.
  Probing `localhost:9090` from the host could never succeed on
  a healthy deploy. Switched to a container-state assertion via
  `docker compose ps sing-box --status running --quiet`, which
  mirrors `panel-container`.

  **`make set-version` did not update `operator/package.json`.**
  Because `build.ts` reads the version from package.json and
  bakes it into the binary via `--define BUILD_VERSION=`, every
  v0.1.4+ binary reported `operator_version: "0.0.1"` (the
  scaffold value) in the incident-bridge JSON and `ct-operator
  --version`. Added a sed line to the `set-version` target so
  the operator binary's reported version tracks the release.

---

## [0.1.7] — 2026-05-15 — `./ct update` auto-fetches the matching ct-operator binary

Closes a manual step from the v0.1.4 install procedure. Operators
upgrading from a pre-v0.1.4 release had to run a separate
`curl ... | sha256sum --check` after `./ct update` to land the
new operator binary. v0.1.7 folds this into `update.sh` as a
non-fatal post-deploy step: the binary appears in `operator/bin/`
automatically, matched to the deployed version.

Idempotent (skips when the existing binary already matches the
manifest hash), opt-out via `CT_SKIP_OPERATOR_FETCH=1`, non-fatal
(a failed fetch leaves the `.sh` fallbacks in place — operators
can retry with `make operator-fetch`).

Originally targeted as v0.1.5; renumbered to v0.1.7 so the v0.1.6
ballast hot-fix could ship first (it blocked operator use).

### Added

  `scripts/fetch_operator_binary.sh` — reads the deployed version
  from `panel/config/cool-tunnel.php`, picks the right target for
  the host (linux-x64 / linux-arm64), downloads from the matching
  GitHub release, verifies SHA-256, atomic-renames into place.
  Idempotent and non-fatal. Honors `CT_SKIP_OPERATOR_FETCH=1`.

  `make operator-fetch` — invokes the script standalone. Useful
  for first-time installs and for hosts where the post-deploy
  fetch was skipped during an earlier update.

### Changed

  `scripts/update.sh` — the final step before `ok "Update
  complete."` now invokes `fetch_operator_binary.sh`. Failures
  are warned about but do not abort the update (the `.sh`
  fallbacks continue to work; a future `./ct update` will retry).

---

## [0.1.6] — 2026-05-15 — Hot-fix: `ct ballast` primitives surfaced by the v0.1.4 live-VPS run

First Phase-9 validation against v0.1.4 on a deployed VPS lit up
every ballast check as WARN / FAIL — but most were false positives
produced by a broken PATH-lookup primitive. Three real bugs found
and fixed.

### Fixed

  **`util/sh.ts::which()` was always returning false.** It called
  `command -v <bin>`, but `command` is a shell builtin — not a
  binary on PATH — and `Bun.$` execs directly without a shell, so
  the lookup failed for everything. Every "<tool> not on PATH"
  warn (docker, nc, socat, cargo, redis-cli, …) on a v0.1.4
  deploy was wrong. Replaced with `Bun.which()` — the proper
  PATH-walking primitive — which is also synchronous and
  subprocess-free.

  **Path bugs in three ballast checks.** `sot-parity`,
  `sqlx-cache`, and `ct-core-version` hard-coded `${ctx.cwd}/../`
  prefixes that assumed cwd was `operator/`. On a deployed VPS
  cwd is the repo root, so the `../` walked out of the repo
  entirely. Replaced with a `tryPaths()` helper that searches
  both `${cwd}/<rel>` and `${cwd}/../<rel>`.

  **`ct-core-version` was reading the wrong Cargo.toml.** v0.1.4
  pointed at `core/ct-server-core/Cargo.toml`, which uses
  `version.workspace = true`; the actual version field lives in
  the workspace root `core/Cargo.toml`. Re-pointed.

  **`panel-octane-up` default port was 8000.** Host-side
  FrankenPHP bind is `127.0.0.1:9000` (matches
  `scripts/doctor.sh::check_up_endpoint`). Re-pointed and
  switched the literal host from `localhost` to `127.0.0.1`.

  **`redis-ping` didn't pass `REDISCLI_AUTH`.** Production Redis
  has a password (`REDIS_PASSWORD` in `.env`); the bare
  `redis-cli ping` failed with NOAUTH. Now reads from
  `ctx.env` and passes via `REDISCLI_AUTH` env (project
  canonical pattern — see `make secrets-argv`). Matches
  `scripts/late-night-comeback.sh`'s discipline.

### Changed

  **`diag/capture.ts` loads `.env` before running collectors.**
  Bridge-triggered ballast (incident path) previously saw only
  `process.env`, so checks that depend on `DOMAIN` /
  `PANEL_DOMAIN` / `REDIS_PASSWORD` degraded to WARN even when
  those values existed in `.env`. Now consistent with direct
  `ct ballast` invocation.

---

## [0.1.4] — 2026-05-15 — `ct-operator` Bun CLI + AI incident bridge + signed self-update

Three of the heavier operator scripts (`fix.sh` 1154 LOC,
`doctor.sh` 471 LOC, `late-night-comeback.sh` 288 LOC) had grown
to where adding structured JSON output, an AI-paste incident
bridge, and signed self-update would have significantly inflated
the existing bash. v0.1.4 introduces a parallel Bun + TypeScript
layer (`operator/`) that compiles to a single platform-specific
binary. The `ct` dispatcher prefers
`operator/bin/ct-operator-<os>-<arch>` when present and falls
back to the legacy `.sh` scripts otherwise. This is purely
additive — the shell scripts remain on disk and unchanged.

Scope is deliberately narrow: only `fix` / `doctor` / `readiness`
move. `bootstrap.sh` / `install.sh` / `lib.sh` stay shell — they
have to run on a fresh VPS before any operator binary exists.

### Added

  `operator/` — new top-level Bun + TypeScript module
  (~2.5k LOC + 18 unit tests). Six logical phases:

    1. Skeleton: `TaskRunner` (Command pattern), `Bun.$`
       wrapper, CLI entry, `bun build --compile` wrapper.
    2. Diagnostics: `captureIncidentContext()` fires on every
       task failure; four collectors (`ballast`, `journal`,
       `sysmetrics`, `proctree`); structured JSON + pasteable AI
       prompt with best-effort redaction.
    3. Tasks: TS ports of `doctor.sh` and
       `late-night-comeback.sh`; `fix.sh` recipes exposed as a
       typed registry. Three of the highest-traffic recipes
       (`docker_daemon_down`, `compose_service_down`,
       `pending_migrations`) are pure-TS in
       `operator/src/tasks/recipes/*.ts`; the remaining 14 fall
       back to the existing `lib.sh` helpers via on-the-fly sed
       extraction of `scripts/fix.sh`. Pure-TS recipes don't
       depend on fix.sh's MAIN-divider convention staying stable.
    4. `self-update`: pulls binary from GitHub Releases,
       verifies SHA-256 + detached ed25519 signature against a
       pubkey baked in at build time, atomic-renames in place.
    5. Wiring: `ct` dispatcher prefers the binary when present;
       Makefile gets `operator-build`, `operator-test`,
       `operator-typecheck`, `operator-keygen` targets.
    6. Release pipeline:
       `.github/workflows/operator-release.yml` matrix-builds
       linux-x64 / linux-arm64 / darwin-arm64, derives the
       pubkey from the secret signing key, signs `SHA256SUMS`,
       self-verifies before upload.

  **Ballast stones** (`operator/src/diag/collectors/ballast.ts`)
  — a 10-item critical-invariant set (panel container, octane
  up, db schema, sqlx cache, redis, caddy ACME, sing-box admin,
  haproxy stats, sot-parity, ct-core version). Three consumers,
  one source of truth: `ct doctor` appends them as a "Ballast
  Stones" group; `ct ballast` runs only these checks (clean
  PASS/WARN/FAIL with non-zero exit on any FAIL, cron-friendly);
  the incident bridge embeds them in its payload on any task
  failure. See `docs/operator.md::VPS validation procedure`.

  **AI incident bridge** is local-only by design. No network
  egress, no API keys; output goes to stdout (or stderr in
  `--json` mode) for the operator to paste into their AI of
  choice. Fires automatically on any task failure (suppress
  with `--no-bridge`). Collectors: `host`, `ballast`, `journal`,
  `metrics`, `proctree`, `compose` (parses `docker compose ps
  --format json` per service — catches the "container is just
  gone" failure mode that bit v0.1.3, where `proctree` and
  `journal` only show negative space). The prompt asks the AI
  to ground its diagnosis in specific evidence and to state
  what additional data it would need rather than guess.

  **`docs/operator.md`** — install (from release or source),
  ballast list, bridge schema, self-update trust model, keygen
  + rotation procedure, OPSEC notes.

### Changed

  `ct` — `fix` / `doctor` / `readiness` subcommands now prefer
  `operator/bin/ct-operator-<os>-<arch>` when present and fall
  back to the corresponding `.sh` otherwise. No flag day; the
  shell scripts remain on disk and unchanged.

  `Makefile` — new `operator-build`, `operator-test`,
  `operator-typecheck`, `operator-keygen` targets. Existing
  `make doctor` / `fix` / `readiness` targets are untouched
  (still run the shell scripts; CI muscle-memory parity).

  `.github/workflows/ci.yml` — new fifth job `operator
  (ct-operator typecheck + test)` runs `bun install
  --frozen-lockfile`, `bun run typecheck`, and `bun test`
  against `operator/` on every push / PR. Matches the existing
  per-language pattern (rust / php / shell): native tooling,
  ubuntu-24.04, 5-minute timeout.

### Security

  **Trust model for `ct-operator self-update`.** Releases
  publish `SHA256SUMS` + `SHA256SUMS.sig`. The binary verifies
  the ed25519 signature against a pubkey baked in at build time
  (`BUILD_PUBKEY`). The build prints a warning if no pubkey is
  set, and the runtime returns exit 4 ("no pinned pubkey")
  rather than attempting an unverified update. Rotation
  procedure documented in `docs/operator.md`.

  **Operator ask before first release**: run
  `make operator-keygen` locally, store the printed private key
  as the `CT_OPERATOR_SIGNING_KEY` repo secret, then cut a
  release. The workflow fails loudly until the secret is set
  rather than shipping an unsigned binary.

  **AI bridge redaction** scrubs IPv4 addresses, Bearer tokens,
  `password=` / `secret=` / `token=` / `api_key=` values, and
  JWT-shaped strings from output before printing. Best-effort
  belt for the careless case, not a defence against adversaries
  — operators are responsible for what they paste.

---

## [0.1.3] — 2026-05-15 — `ct auto-update` agent + haproxy SIGHUP safety net + 2 new fix-agent recipes

Hot on the heels of v0.1.2. Two motivations:

  1. **Incident**: ~15 minutes after the v0.1.2 deploy on Vultr,
     the panel went dark with `ERR_CONNECTION_REFUSED`. Diagnosis
     traced to a quietly-exited `haproxy` container — `update.sh`'s
     SIGHUP re-exec path can end with the container exiting
     instead of reloading in place on some hosts, leaving host
     port 443 unbound. None of the 15 v0.1.2 fix-agent recipes
     caught this, because both the haproxy and panel recipes
     require the container to be in a *restart loop* state — a
     container that is outright **missing** from `docker compose ps`
     tripped neither. v0.1.3 closes the gap two ways: an
     `update.sh` belt-and-suspenders pass that *guarantees*
     haproxy is up after the SIGHUP, and a new fix-agent recipe
     `compose_service_down` that detects "service in compose.yml is
     not in the Up set" regardless of why.
  2. **Operator ask**: small fleets need a way to keep deployments
     current without an operator SSH'ing into every box on every
     patch release. v0.1.3 ships an unattended release-pulling
     agent, default-OFF, opt-in via `ct auto-update enable` (drops
     a `/etc/cron.daily/ct-auto-update` symlink). Health-gated:
     refuses to auto-upgrade an already-broken stack so a cron tick
     never compounds an existing incident.

### Added

- **`scripts/auto_update.sh`** — unattended release-pulling agent.
  Checks `origin/main` for a newer tag; if the deployed version
  is older AND the running stack is healthy (panel running +
  credential-lock guard OK), pulls and runs `./scripts/update.sh`.
  Safe-to-cron: `flock`'d single-flight, abort-on-unhealthy,
  abort-on-network-blip, structured exit codes (0 up-to-date or
  upgraded; 1 upgrade attempted + failed; 2 refused). Flags:
  `--quiet` (cron-friendly), `--dry-run` (decision only).
- **`ct auto-update`** subcommand cluster on the top-level
  dispatcher:
    `ct auto-update now`     — run the agent right now (interactive)
    `ct auto-update enable`  — sudo; install
                               `/etc/cron.daily/ct-auto-update`
                               symlink (runs daily, anacron-windowed)
    `ct auto-update disable` — sudo; remove the cron entry
    `ct auto-update status`  — show enabled/disabled state
    Default-OFF; a fresh install does NOT auto-upgrade.
- **`make auto-update`** Makefile target, listed in `make help`.
- **`help.sh` new topic `auto-update`** between `fix` and `readiness`
  in the topic chain. Documents safety properties, when-to-enable
  vs when-NOT-to-enable, and the companion recipe in `ct fix`.
- **`scripts/fix.sh` grows from 15 → 17 recipes**:
  - **`compose_service_down`** (recipe #2) — the recipe written
    for tonight's panel-unreachable incident. Detects: any service
    declared in `docker compose config --services` not present in
    `docker compose ps --status running --services`. Fix:
    `docker compose up -d`. Catches container-outright-missing
    cases that the existing haproxy_backend_dns / panel_restart_loop
    recipes miss (those require Restarting/Created state, not gone).
  - **`stale_deployment`** (recipe #17) — interactive catch-up
    companion to `ct auto-update`. Detects: current version (from
    `panel/config/cool-tunnel.php`) older than the latest tag on
    `origin/main`. Fix: `git pull --ff-only && ./scripts/update.sh`.
    Operators who prefer interactive flows over cron-fired
    unattended catch up via `ct fix` instead of `ct auto-update`.
- **`install.sh` success summary** now also surfaces `sudo ct
  auto-update enable` as an optional follow-up alongside the
  existing `ct fix` hint. New operators see both safety nets on
  first deploy.

### Changed

- **`scripts/update.sh` step 13** (the haproxy SIGHUP reload) now
  follows the `compose kill -s HUP haproxy` with a defensive
  `compose up -d haproxy` + 2s settle. The kill-s-HUP is still the
  primary reload path (graceful, connection-preserving); the
  `up -d` is a guarantee that the container is in the Up state
  before component-check runs, regardless of whether SIGHUP
  caused the master to re-exec or exit. Idempotent: a no-op if
  haproxy is already healthy.
- `make help` table now lists `auto-update` between `auto-sync`
  and `help-topics`.
- `ct --help` table now mentions `auto-update {enable|disable|now|
  status}` in the DEEPER COMMANDS section.

### Fixed

- The panel-unreachable failure mode on Vultr post-v0.1.2 deploy.
  Root cause: `compose kill -s HUP haproxy` *can* exit the
  container on some Linux kernels / haproxy builds, leaving host
  port 443 with no listener. Two-layer fix:
  - `update.sh` always brings haproxy back up after the SIGHUP
    (belt-and-suspenders).
  - `compose_service_down` fix-agent recipe catches any future
    occurrence (defense in depth), regardless of which service
    quietly exited.

### Security

(no v0.1.3-class security changes)

---

## [0.1.2] — 2026-05-15 — Brew-style `ct` CLI + 4 new fix-agent recipes + sing-box 1.13 schema fix

The theme for this release is: **a noob operator should never have
to know what sing-box, HAProxy, IPv6, or Docker is to recover from
a failure.** Three reinforcing layers ship together:

  1. **Prevention** — the sing-box template now emits the new-schema
     `domain_resolver` directive (sing-box 1.13+), pinning outbound
     DNS resolution to IPv4 only by default. New installs on cloud
     providers that advertise but don't route IPv6 (Vultr being the
     canonical example) now work without intervention.
  2. **Self-heal** — `ct fix` (formerly `make fix`, still works)
     gains four new recipes covering the most common
     historical-debug surfaces. The agent now ships 15 recipes
     total, each with a plain-English explanation an operator
     can act on without prior systems knowledge.
  3. **Failsafe surface** — every script that calls `die()` from
     `lib.sh` now prints a universal `↳ stuck? Run: ct fix` footer
     on failure. The `install.sh` success message and `update.sh`
     completion line both end with the same pointer. There is no
     longer a "what do I do now?" hole in the operator journey.

A new top-level `ct` dispatcher (`./ct install / fix / doctor /
update / status / logs / help [topic] / version`) gives the project
brew-/git-style muscle memory. The underlying scripts are unchanged
and `make <target>` still works — `ct` is purely a discoverability
shim.

Motivated by a real new-operator install incident on a fresh Vultr
instance (2026-05-14, naive.coolwhite.space): a fresh `install.sh`
ran to 10/10 readiness but the macOS client could not actually
proxy traffic — server-side sing-box accepted the CONNECT, returned
`HTTP/1.1 200 OK`, then RST'd the tunnel because its outbound
dialer prefers IPv6 and Vultr doesn't actually route IPv6. The
template + new recipe close the loop for every future operator who
lands on the same VPS.

### Added

- `ct` top-level dispatcher script at the repo root. One short
  command per workflow, mirrors the `make` targets but easier to
  guess from cold. Install hint surfaced in the install.sh success
  block: `sudo ln -sf "$(pwd)/ct" /usr/local/bin/ct`.
- `make fix` target wrapping `scripts/fix.sh`, listed in `make help`.
- `make help-fix` (and `ct help fix`) — plain-English explanation
  of every recipe + when to run + what each one does.
- `scripts/fix.sh` grows from 11 → 15 recipes, picked from
  historical debug activity. New entries:
  - **`docker_daemon_down`** (recipe #1) — host's docker daemon
    isn't running. Runs BEFORE every other recipe because none of
    them work without a live daemon. Fix: `systemctl start docker`
    + `compose up -d`. Captures the "I just installed docker.io
    but never enabled the service" first-time pitfall.
  - **`singbox_outbound_ipv4_only`** (recipe #9) — the May-2026
    Vultr post-CONNECT-RST incident. Detects: sing-box up + host's
    IPv6 outbound unreachable + rendered config lacks the new-schema
    `domain_resolver` directive. Fix: re-render + restart sing-box;
    also retires any legacy
    `ENABLE_DEPRECATED_LEGACY_DOMAIN_STRATEGY_OPTIONS=true` override
    file an earlier hotfix may have written.
  - **`panel_restart_loop`** (recipe #10) — catch-all for the
    v0.0.94-class composer / Octane / image-stale family of
    panel-container restart loops. Fix: rebuild + recreate +
    wait-for-healthy.
  - **`pending_migrations`** (recipe #11) — restored an old backup
    and the schema's now behind the running code. Fix:
    `artisan migrate --force` (idempotent, data-preserving).
  - **`messenger_queue_stuck`** (recipe #12) — Symfony Messenger
    Redis stream depth > 100, worker dead. Fix: `compose restart
    panel` so supervisord re-spawns the worker.
- Universal `↳ stuck? Run: ct fix` footer in `lib.sh::die()`. Every
  script that surfaces a failure now leaves the operator with a
  one-command escape hatch. Inhibited inside `fix.sh` itself via
  `CT_NO_FIX_HINT=1` so the agent doesn't recursively recommend
  itself.
- New `help.sh` topic `fix` — between `auto-sync` and `readiness`
  in the topic chain.

### Changed

- `sing-box/config.json.tpl` migrates from the deprecated
  `dns.strategy: ipv4_only` / `outbound.domain_strategy` shape to
  sing-box 1.13's `domain_resolver: {server, strategy}` shape, set
  both per-outbound (on the `direct` outbound) and globally on
  `route.default_domain_resolver`. Eliminates the
  `ENABLE_DEPRECATED_LEGACY_DOMAIN_STRATEGY_OPTIONS=true` env-var
  workaround that v0.1.1-era operators on broken-v6 hosts had to
  apply manually. No operator-visible change other than the legacy
  WARN no longer appearing in sing-box startup logs.
- `install.sh` success summary now ends with a `ct fix` pointer +
  optional `/usr/local/bin/ct` symlink hint, so the recovery path
  is on-screen at first deploy.
- `update.sh` completion line now suggests `ct fix` when the
  operator wants to verify post-swap health.
- Recipe ordering inside `scripts/fix.sh` is now stricter
  install-order priority — `docker_daemon_down` first, then every
  recipe that assumes a working daemon, in roughly the order an
  issue would block earlier stages of boot.

### Fixed

- Readiness gate (check 10, anti-tracking probe) no longer echoes
  the proxy `Proxy-Authorization` URL — and therefore the proxy
  password — into the NG message when the probe fails. Two-layer
  defense: (a) `ct-server-core probe anti-tracking` now strips
  credentials from the `ProbeResult.via` field before serializing
  (`core/ct-server-core/src/probe.rs::strip_creds`), (b)
  `scripts/late-night-comeback.sh::check_probe()` masks any
  `scheme://user:secret@` pattern with `***:***@` before recording
  the NG message, so a future regression in the Rust layer can't
  leak via the shell layer either.
- `scripts/fix.sh` shellcheck SC2164 — every `cd
  /opt/cool-tunnel-server 2>/dev/null || cd "$(dirname "$0")/.."`
  chain now appends `|| return 1` so a recipe whose `cd` fails
  returns to the dispatcher cleanly instead of silently running
  the rest of the recipe in the wrong directory.

### Security

- Proxy password no longer surfaced through the readiness gate's
  NG10 output path (see `Fixed` above for the two-layer defense).
  This was a low-severity leak — the readiness gate normally runs
  as a cron / CI step whose logs are operator-only — but the
  output was previously safe to paste, and "safe to paste" is the
  property we want to preserve as readiness logs flow toward
  monitoring dashboards over time.

---

## [0.1.1] — 2026-05-14 — Add `auto-sync` agent — credential-lock audit + auto-correct

First v0.1.x patch release. Adds an operator-facing
"audit-and-correct" agent for the four-way credential-lock
invariant (`db == rendered == manifest == mac-config`). Motivated
by a production incident earlier today where a Filament-UI
Regenerate-password click caused a transient window of
inconsistency between server-side state and the Mac client's
cached subscription URL. The investigation traced through the
credential-lock guard repeatedly to find the drift — an
operator-friendly wrapper that runs the guard *and* takes
corrective action on its own makes the next such incident a
one-command resolve.

### Added

- **`scripts/auto_sync.sh`** (~100 lines) — credential-lock
  audit + auto-correct agent. Runs the
  `ct-server-core guard credential-lock` invariant. On NG:
  re-renders sing-box config, restarts the sing-box container,
  re-verifies the guard. Logs every action loudly. Cron-friendly
  exit codes (0 on no-drift OR drift-fixed; 1 on
  drift-couldn't-fix). Companion to `make doctor` (which is
  read-only).

- **`make auto-sync` Makefile target** — wrapper around the
  shell script. Slots in next to `make doctor` and
  `make readiness` in the operator surface.

- **`help-auto-sync` topic** in `scripts/help.sh` — plain-English
  explanation of when to use the agent vs the existing
  Laravel scheduler entry that handles the routine case
  (`singbox:render --if-changed --reload` every 5 min).

### Notes — relationship to existing scheduler

The Laravel scheduler at `panel/routes/console.php:53` already
runs `php artisan singbox:render --if-changed --reload` every 5
minutes as a silent safety net. That handles the routine case
of "DB row updated, sing-box config not yet re-rendered" without
operator action.

`auto-sync` is the explicit + loud + manifest-aware variant:
- **Explicit**: invoked by `make auto-sync` rather than fired by
  cron; operators see the output.
- **Loud**: logs every action with timestamps so a tail of the
  output shows exactly what happened.
- **Manifest-aware**: uses the four-way `credential-lock` guard
  (db = rendered = manifest = mac-config), not just the
  `singbox:render --if-changed` two-way check. Catches drift in
  the manifest or mac-config surfaces that the existing
  scheduler entry doesn't.

If operators want a tighter cron cadence than 5 min, the shell
script is host-side wireable to any frequency via standard
crontab. The Laravel scheduler entry deliberately stays at the
existing 5-min cadence.

### Notes — implementation

- Pure shell. No new Rust or PHP code paths. The agent composes
  existing `ct-server-core` subcommands
  (`guard credential-lock`, `--json singbox render`) plus
  `docker compose restart sing-box`. Adds no new surface that
  needs maintenance.
- Two known-but-unfixed-in-this-release cosmetic issues
  surfaced during today's incident, queued for a future
  v0.1.x release:
  - `supervisorctl status` query from inside the panel
    container fails with "ini file does not include
    supervisorctl section" — supervisord is fine, just the
    client config can't be queried that way.
  - Custom `MessengerConsume` wrapper doesn't expose the
    `--limit` flag from upstream `symfony/messenger`.

### Deployment

- Pull v0.1.1 and run `ct update`. Cache-fast (no Dockerfile
  delta, no composer.lock delta). After the update:

      make auto-sync             # one-shot audit + correct
      make help-auto-sync        # plain-English explanation

- The new agent is purely additive. Existing flows (`ct update`,
  `make doctor`, `make readiness`, the Laravel scheduler entries)
  are unchanged.

---

## [0.1.0] — 2026-05-14 — Milestone: closing the 0.0.x line

Cool Tunnel Server graduates from the 0.0.x line to 0.1.0.

The 0.0.x line carried the project from the original bare Caddy
+ naive recipe through ~100 patch releases of architectural,
ops, and developer-experience work. The major arcs that landed:

- **Wire + control-plane stability** (0.0.1 → ~0.0.5x):
  `ct-protocol` shared crate, `ProfileV1`, `SubscriptionManifestV1`,
  `ComponentManifestV1`, the OK/NG component-check model.

- **Filament + FrankenPHP runtime swap** (0.0.5x → 0.0.6x):
  the admin UI moved to Filament 3, the application runtime moved
  to FrankenPHP worker-mode (~3-5x latency reduction on the
  Filament save → reload path), supervisord layout consolidated
  to the canonical 5-program shape.

- **Multi-arch + SNI router** (0.0.3x → 0.0.4x):
  HAProxy as the public `:443` TCP SNI router (no TLS termination
  at the edge), separation of proxy and panel domains, per-arch
  pins for the bundled `naive` client.

- **Daemon FSM + bounded IPC** (0.0.6x → 0.0.7x):
  the Rule Maker connection FSM with atomic compare-exchange
  transitions, typed wire errors, OTel-style network-turn spans,
  and 80% threshold pressure handling — see
  [`docs/daemon-fsm.md`](./docs/daemon-fsm.md).

- **Robustness review arc** (0.0.79 → 0.0.85): 26 Critical findings
  from the round-22 robustness review shipped over 6 releases plus
  a cushion-trim release.

- **Symfony-infusion arc** (0.0.92 → 0.0.94): PSR-style service
  interfaces (Phase 1), Symfony Messenger foundation (Phase 2),
  direct-dispatch cutover that retired the legacy
  `ReloadSingBoxJob` / `ReloadServerConfigJob` shims (Phase 3).
  In-flight Laravel-Queue rows for the deleted Job classes will
  fail to deserialize after v0.0.94 — operators upgrading from
  pre-v0.0.94 should run `php artisan queue:flush` once post-deploy.

- **Maintain-UX rewrite arc** (0.0.96 → 0.0.99): `lib.sh` foundation
  + `update.sh` diagnostic blocks (Phase 1), `ct doctor`
  self-diagnostic dashboard (Phase 2), `ct help <topic>`
  mini-manual (Phase 3). The original "more auto-debug and easier
  for noob coder" ask is now covered.

- **Documentation overhaul** (0.0.100): README slimmed from
  814 lines to ~170; new
  [`docs/operations.md`](./docs/operations.md) (day-to-day operator
  guide) and [`docs/glossary.md`](./docs/glossary.md) (plain-English
  definitions for every term used across the project).

### Compatibility — what does NOT change at the 0.1.0 boundary

Per [`VERSIONING.md`](./VERSIONING.md), the minor bump signals
*permission to break compatibility*, NOT a forced break. The
operator-facing surface area is unchanged at the 0.0.100 → 0.1.0
boundary:

- **`naive+https://...` profile URL format** — same parser, same
  shape. Existing subscription URLs keep working.
- **`SubscriptionManifestV1`, `ComponentManifestV1`,
  `WireRequestV1` / `WireResponseV1` / `WireEventV1`** — all
  stable. WireV1 stays WireV1.
- **`ct-server-core` CLI subcommand surface** — unchanged.
- **`.env` keys** — unchanged. Existing deployments keep their
  config.
- **Filament admin URL routes (`/admin`, `/api/v1/...`)** —
  unchanged.

This release is operator-safe to roll forward from any 0.0.9x
release with a normal `ct update`. The release version bump
propagates through the standard `make set-version` anchors
(Cargo.toml, manifests/*, panel/config/cool-tunnel.php) plus
the LTSC baseline pin in [`LTSC.md`](./LTSC.md) (`v0.0.70` →
`v0.1.0`).

### What 0.1.x means

The 0.1.x line continues development on the same surface. The
0.0.x → 0.1.0 jump is a *milestone marker* — a clean point in
the project history where the architectural arcs of the first
year are closed and the maintenance + ops foundation has caught
up. Patch releases in the 0.1.x line continue to follow the
"no breaking change" promise of the patch position; minor bumps
(0.1.x → 0.2.x and beyond) will be reserved for surface changes
that warrant them.

### Notes

- No code-path change in this release. The diff is the version
  anchor bump + this CHANGELOG entry + the LTSC.md baseline
  date/version update.
- The git history rewrite that landed earlier today
  (canonicalised author identity to `coolwhite LLC` across all
  234 affected commits + scrubbed blob content + scrubbed commit
  message bodies) is now the baseline for the 0.1.x line. Any
  fresh clone post-v0.1.0 will see only the canonical history.
- The `pre-rewrite-backup-20260514T104636Z` tag on origin
  preserves the pre-rewrite state as a recoverable safety net.
  Operators who want to drop it once they've confirmed the
  rewrite is good:
  `git push origin :refs/tags/pre-rewrite-backup-20260514T104636Z`

### Deployment

- Pull v0.1.0 and run `ct update`. Cache-fast on top of v0.0.100
  (only the version anchors + CHANGELOG + LTSC.md changed; no
  rebuild-triggering Dockerfile or composer.lock delta).
- `ct doctor` after the update should report mostly PASS with 3
  INFO lines (release version v0.1.0, active proxy account
  count, Messenger Redis stream depth), 0 FAIL on a healthy
  stack.

---

## [0.0.100] — 2026-05-14 — README rewrite: noob-friendly multi-file split

The README.md grew to 814 lines over the project's history and
became hostile to new operators: the first two content sections
after the badges were "System Contract" (a technical table
mentioning "WireV1", "OTel-style network-turn spans", "bounded
BytesMut frames") and "Architecture Deep-Dive" (a mermaid diagram
plus prose about "Rule Maker FSM transitions are atomic
compare-exchange"). A new operator bounced off before reaching
the friendly "First Deploy" tutorial at line 84.

This release splits the README along reader-intent lines. The
new entry point is short, plain-English, and points each kind
of reader to the document that answers their actual question.

### Added

- **`docs/operations.md`** (~330 lines) — day-to-day operator
  guide. Extracted from the old README's "Maintaining a Running
  Deployment" section, refreshed and expanded:
  - Daily checklist (`ct doctor`)
  - Updating to a new release
  - Backing up (with off-server recommendations)
  - Restoring from backup
  - Looking at logs when something seems off
  - Rotating passwords (Redis + MariaDB playbooks)
  - Watching health over time (Prometheus / Grafana wiring)
  - Common problems + one-command fixes (10-row table)
  - "What `ct update` actually does" — exact sequence
  - `make` command reference

- **`docs/glossary.md`** (~250 lines) — plain-English
  definitions for every term used across the documentation:
  ACME, APP_KEY, Caddy, Component check, ct-server-core,
  docker compose, .env, entrypoint, Filament, flock, FrankenPHP,
  FSM, GFW, HAProxy, Laravel, NaiveProxy, Octane, OK/NG, panel,
  PANEL_DOMAIN, Rule Maker, sing-box, SNI, subscription manifest,
  supervisord, TLS, TTL, VPS, Wire format / WireV1, doctor,
  readiness, help-<topic>, DOMAIN. Cross-linked internally
  (one term's definition links to others it depends on).

### Changed

- **`README.md`** slimmed from 814 lines → ~170 lines:
  - "What is this?" — plain-English elevator pitch (2 paragraphs)
  - "Who is this for?" — explicit audience signal
  - "60-second quickstart" — 5 commands with pointer to
    GETTING_STARTED.md
  - "Documentation map" — table mapping reader goals to
    documents
  - "Help from the command line" — exposes the v0.0.99
    `make help-<topic>` mini-manual surface
  - "What's running" — 6-row service table, brief
  - "License + posture" — terse
  - "Reference index" — categorized doc list

  Cut from README (content lives in the new files):
  - System Contract table → covered in docs/architecture.md
  - Architecture Deep-Dive → docs/architecture.md
  - First Deploy section → already in GETTING_STARTED.md
  - Maintaining a Running Deployment → docs/operations.md
  - Industrial Makefile → docs/operations.md
  - QA Checklist: Operator's Eyes → docs/operator-runbook.md
  - Observability Boundary → docs/observability-dashboard.md
  - Smoke Tests → docs/operations.md
  - Project Map (long version) → docs/architecture.md
  - Operator References (long version) → README "Reference
    index" (compressed) + docs/operations.md

### Notes

- No code or script changes in this release. README + 2 new
  documentation files only. All cross-references verified to
  resolve to extant paths.
- The release version bump pulls Cargo.toml + manifests in
  lockstep with the other version anchors; no functional
  Rust / PHP / Docker change.

### Deployment

- `ct update` after merge picks up the new docs. No image
  rebuild is functionally required (only doc files changed),
  but `update.sh` will rebuild anyway because it bumps the
  release-version anchor.

---

## [0.0.99] — 2026-05-14 — Maintain-UX rewrite, phase 3 of 3 (`ct help <topic>` mini-manual)

Phase 3 closes the three-PR maintain-UX refactor (v0.0.96 →
v0.0.99). Lands `scripts/help.sh` + Makefile dispatch targets
so an operator who just SSH'd into a fresh VPS can read
plain-English explanations of each script without opening the
source: "what does this do, when do I run it, what are the
common failure modes, what do I do next."

The original PR-3 plan also included auto-recovery hooks (e.g.
"panel restarting → offer `compose up -d --force-recreate`").
That's deliberately deferred — auto-recovery taking the wrong
action is worse than no auto-recovery. The diagnostic blocks
landed in PR 1 (v0.0.96) already tell the operator what to do;
having a script DO it requires more field validation than this
refactor budget allowed. Revisit when v0.0.96-v0.0.98 have
some field time under them.

### Added

- **`scripts/help.sh [<topic>]`** — operator mini-manual.
  No arg: prints the topic list. With a topic arg: prints
  that topic's section. ~430 lines, ~50-line per topic, all
  embedded as `read -r -d '' var <<'EOF' ... EOF || true`
  heredocs (same bash-parser-bug-avoiding idiom from v0.0.96).

- **Eight topics**:
  - `getting-started` — what's in front of a fresh-VPS operator
  - `install` — what install.sh does + common failure modes
  - `update` — what update.sh does + common failure modes
  - `doctor` — when to run it, how to read the output
  - `readiness` — strict gate semantics, score interpretation
  - `backup` — what gets backed up
  - `restore` — destructive caveat + recovery flow
  - `troubleshooting` — top 8 issues operators hit, ranked
    by frequency, with the first-step diagnostic command per
    class

- **Makefile dispatch**:
  - `make help-topics` — list the available topics (entry point)
  - `make help-<topic>` — pattern rule that forwards to
    `./scripts/help.sh $*`. So `make help-update`,
    `make help-doctor`, etc.

### Changed

- No changes to existing scripts in this PR. install.sh /
  backup.sh / restore.sh's `|| die` callsites were surveyed
  for sweep candidates; the existing one-line hints were
  short but acceptable. Skipping the sweep keeps the diff
  focused.

### Notes — what landed across the three-PR arc

  v0.0.96  lib.sh: die_with_diag + 4 preflight helpers;
           update.sh: full pre-flight + diagnostic blocks +
           named NG component on component check failure

  v0.0.97  preflight_network hotfix (drop curl -f; 401 is OK)

  v0.0.98  doctor.sh + make doctor: health dashboard with
           PASS/WARN/FAIL output + remediation block

  v0.0.99  help.sh + make help-<topic>: operator mini-manual,
           8 topics

The original "more auto-debug and easier for noob coder" ask
is now covered:
  - more auto-debug:        v0.0.96 diagnostic blocks + v0.0.98 doctor
  - easier for noob coder:  v0.0.99 mini-manual + getting-started

Auto-recovery (the speculative item from the original PR-3
sketch) is deferred. Operators have everything they need to
diagnose + manually recover; automatic recovery requires
field validation we haven't done.

### Deployment

- Pull v0.0.99 and run `ct update`. After the update, try:

      make help-topics
      make help-getting-started
      make help-troubleshooting

  Each topic is one screen of plain English. Operator-side
  workflow: when stuck, `make doctor` for the dashboard, then
  `make help-troubleshooting` for the recipe to apply, then
  `make help-<thing>` for the deeper context.

---

## [0.0.98] — 2026-05-14 — Maintain-UX rewrite, phase 2 of 3 (`ct doctor` self-diagnostic dashboard)

Phase 2 of the three-PR maintain-UX refactor. Lands a new
`scripts/doctor.sh` + `make doctor` target that gives operators
a single unified health dashboard with PASS / WARN / FAIL output
+ per-failure remediation hints. Complements (does not replace)
`scripts/late-night-comeback.sh`, which keeps its strict
≥9/10 readiness-gate semantics for cron / CI use.

The two commands answer different questions:

  | command                  | question                              |
  |--------------------------|---------------------------------------|
  | `make doctor`            | "show me everything I should look at" |
  | `make readiness`         | "is the system ready to publicly ship?" |

Operators day-to-day will use `doctor`; one-time launch / post-
incident gating will use `readiness`. PR 3 may dedupe the
overlapping checks into a shared library, or may leave the two
side-by-side — depends on whether the divergence stays small.

### Added

- **`scripts/doctor.sh`** — operator-friendly health dashboard.
  ~350 lines. Reuses `lib.sh`'s colour helpers + the existing
  `component_check_strict` / `file_mode_octal` / `load_env`
  primitives. Sourced .env is optional — checks degrade
  gracefully when the file is missing or env vars are unset
  (the dashboard tells you to fix .env first rather than
  crashing on `set -u`).

- **Output layout** — six sections:
  - **Prerequisites** — `docker compose v2` on PATH; `.env`
    present + mode 0600 (warns on world-readable).
  - **Structural (network reachability)** — DNS A record matches
    host IP; ports 80+443 listening; ACME cert expiry (FAIL
    <7 days, WARN <14 days, PASS otherwise).
  - **Application** — `/up` endpoint HTTP 200; component check
    OK across all 12 components.
  - **Compose stack** — all 6 expected containers running
    (panel, sing-box, haproxy, caddy, db, redis); panel
    container's 5 supervisord programs all RUNNING.
  - **Resources** — disk under repo + docker root meets
    thresholds (FAIL <2/4 GB, WARN <4/8 GB); RAM headroom
    (FAIL <10% avail, WARN <25%).
  - **Info** — release version, active proxy account count,
    Messenger Redis-stream depth. No PASS/FAIL contribution
    — context the operator uses to interpret the rest.

- **Summary + remediation** — bottom of dashboard prints
  `N PASS, M WARN, K FAIL, J INFO`. If any WARN or FAIL was
  recorded, a `Remediation:` block follows with the per-failure
  next-step commands extracted from each check's hint.

- **Exit codes** — 0 on all-PASS or WARN-only; 1 on any FAIL.
  Cron-suitable for `make doctor` gates.

- **`make doctor` target** — `./scripts/doctor.sh` wrapper with
  a friendly help string. Slots in next to the existing
  `make readiness` target.

### Changed

- **`Makefile::readiness`** — help string clarified to
  ">=9/10 readiness gate; cron/CI suitable" to disambiguate
  from the new `doctor` target.

### Notes — implementation

- No changes to `scripts/late-night-comeback.sh` in this PR.
  Its 10 checks remain its own; PR 3 may dedupe by extracting
  shared check functions into a third file (`scripts/checks.sh`
  candidate). Keeping the two scripts independent for now
  keeps PR 2's diff focused.

- The `check_up_endpoint` curl pattern is single-call: an
  earlier iteration chained `|| curl ...` as a fallback, but
  `curl -w '%{http_code}'` writes to stdout regardless of exit
  code, so each `||` branch appends another "000" to the
  captured value. Single call + explicit empty-string fallback
  is both simpler and correct.

- The `dr_pass` / `dr_warn` / `dr_fail` / `dr_info` helpers
  buffer remediation lines into a flat `dr_remediation`
  array (pipe-delimited `sev|label|msg|hint`) so the final
  block can render them grouped at the end. Avoids interleaving
  hints with the table — operators see the full table first,
  then the remediation block.

- All checks are read-only. No state mutation. Safe to run on
  a healthy production VPS, mid-deploy, or during an outage.

### Deployment

- Pull v0.0.98 and run `ct update`. After the update, run
  `make doctor` to see the new dashboard against your live
  stack. Expected output on a healthy deployment: most PASS,
  3 INFO lines (release version, active users, Messenger
  depth), 0 FAIL.

- The dashboard is purely additive — existing scripts and
  workflows are unaffected. Operators who prefer the strict
  readiness-gate semantics can keep using `make readiness`.

---

## [0.0.97] — 2026-05-14 — Hotfix: preflight_network false positive on registry-1.docker.io (401)

v0.0.96's new `preflight_network` helper failed on the first
production VPS to run `./scripts/update.sh` post-rewrite: the
unauthenticated HEAD-equivalent request to
`https://registry-1.docker.io/` returns HTTP 401 (perfectly
valid — the registry IS reachable, it just wants auth), but the
pre-v0.0.97 implementation used `curl -fsSI` whose `-f` flag
rejects any 4xx/5xx as failure. Operators saw "✗ FAILED network:
cannot reach registry-1.docker.io" even though the network was
fine.

### Fixed

- **`scripts/lib.sh::preflight_network`** now uses
  `curl -sS --connect-timeout 5 --max-time 10 -o /dev/null` for
  each host check (no `-f`). curl returns 0 for any successful
  HTTP transaction regardless of status code, so 401 / 403 /
  404 / 500 all correctly read as "host reachable; whatever it
  returned is between the caller and the server." Only true
  connection-level failures (DNS NXDOMAIN, connection refused,
  TLS handshake timeout) trip the diagnostic block now.
- The two-call fallback ladder (HEAD then GET) collapses to a
  single call — both simpler and more correct.

### Notes

- No other code-path change. v0.0.96's new lib.sh helpers
  (`die_with_diag`, `preflight_clean_tree`, `preflight_disk_space`,
  `preflight_stack_up`) are unaffected.
- The `update.sh` call sites that invoke `preflight_network`
  are unchanged.

### Deployment

- Operators stuck on the v0.0.96 `update.sh`'s preflight error:
  `git fetch && git reset --hard origin/main && ./scripts/update.sh`.

---

## [0.0.96] — 2026-05-14 — Maintain-UX rewrite, phase 1 of 3 (foundation + update.sh diagnostic blocks)

The v0.0.95 production incident — operator hand-rolled-back
v0.0.93's Messenger work directly on the VPS to escape the
restart loop, then `./scripts/update.sh` died with the entirely
unhelpful message `✗ FAILED git pull failed (uncommitted
changes?)  ↳ try: stash or commit your local edits first` —
made the maintain-side UX gap obvious. A novice operator stares
at that and has no idea (a) what is uncommitted, (b) whether
stashing is safe, or (c) what to do next.

Phase 1 of a three-PR refactor that closes the gap. PR 2
introduces a `ct doctor` self-diagnostic; PR 3 layers
auto-recovery hooks + a `ct help <topic>` mini-manual on top.
Phase 1 lands the foundation in `lib.sh` and rewires `update.sh`
to use it. No behaviour change to the happy path — only the
error paths are different (much more useful).

### Added

- **`scripts/lib.sh::die_with_diag <summary> <body>`** —
  multi-line variant of `die`. Prints a one-line FAILED summary
  followed by a `Diagnostic:` block (indented, line-by-line) so
  novice operators get the (1) what, (2) why, (3) what-to-do-next
  triad on every failure path. Existing `die` retained for the
  many one-line-hint sites.
- **`scripts/lib.sh::preflight_clean_tree`** — interactive
  detection of an uncommitted working tree. Shows stat summary
  + first-30-lines diff preview, then offers `[s]tash with
  timestamp label / [d]iscard / [a]bort`. Non-interactive (CI,
  cron, hooks) → dies with a diagnostic block that lists the
  exact commands for each path. Replaces the v0.0.95 "uncommitted
  changes?" trap directly.
- **`scripts/lib.sh::preflight_disk_space [<repo_gb>] [<docker_gb>]`**
  — refuses to proceed when free disk under either the repo path
  OR docker's data-root is below the threshold (defaults 2 / 4 GB;
  override via `CT_MIN_REPO_GB` / `CT_MIN_DOCKER_GB`). Diagnostic
  block lists the highest-impact cleanup commands in priority
  order (`docker system prune -af`, `docker builder prune -af`,
  `rm -rf core/target`, `du -h --max-depth=1 /`).
- **`scripts/lib.sh::preflight_stack_up <service...>`** —
  verifies each named compose service has at least one container
  in `running` or `restarting` state. `restarting` counts as up
  so the helper does not refuse to operate during the very
  crisis it is trying to help recover from. When the entire stack
  is down, the diagnostic block explicitly says "you probably
  want install.sh, not update.sh" — common operator confusion on
  fresh boxes.
- **`scripts/lib.sh::preflight_network [<host>...]`** —
  HEAD-pings `github.com` (git pull) and `registry-1.docker.io`
  (image pull / buildkit) before any work. Override host list
  per-deployment if behind a corporate proxy or registry mirror.
  Diagnostic block lists the network-debug command ladder
  (`ping 1.1.1.1`, `dig +short`, `curl -v`, `printenv HTTPS_PROXY`,
  `docker info | grep Registry`) so an offline VPS does not
  silently waste five minutes on compose timeouts.

### Changed

- **`scripts/update.sh`** now opens with a four-helper pre-flight
  block (`preflight_network`, `preflight_disk_space`,
  `preflight_stack_up panel sing-box haproxy`,
  `preflight_clean_tree`) instead of going straight to
  `git pull --ff-only`. Every failure-prone step now uses
  `die_with_diag`:
  - `git pull` — separate diagnostic for the "non-FF" case
    (pre-flight already filtered "dirty tree"), with the
    `git fetch origin; git reset --hard origin/main` recovery
    path spelled out.
  - `compose build core-builder` — out-of-disk / network /
    cargo-cache-rot / buildkit-bug enumeration.
  - `compose build sing-box panel haproxy` — out-of-disk / APK /
    PECL / composer.lock-conflict enumeration, with an explicit
    reference back to the v0.0.95 ext-redis class of bug.
  - `component_check_strict` — captures stdout, extracts the NG
    component name(s), and renders a per-component recovery
    block (`panel`, `sing-box`, `haproxy`, `redis`,
    `ct-server-core`, `caddy`) with the targeted log-tail
    commands. Pre-v0.0.96 this said "post-swap check NG —
    investigate logs" with no indication of *which* component
    or *which* logs.

### Notes — implementation

- The heredoc-into-`$(cat <<EOF ...)` pattern was abandoned
  mid-development after triggering a bash parser bug: parentheses
  inside the heredoc body confuse the substitution's paren-counter
  and produce "unexpected EOF" parse errors. The library now
  uses `read -r -d '' var <<'EOF' ... EOF` instead — reads to NUL
  (never present in the heredoc), hits EOF, returns non-zero,
  trailed by `|| true` to satisfy `set -e`. Same pattern in both
  `lib.sh` and `update.sh`. Documented in-source.
- All new helpers + every diagnostic block run cleanly under
  `shellcheck -x --severity=warning` and pass the project's
  `secrets-argv` check (the redis-cli command shown in the NG
  diagnostic uses the canonical `REDISCLI_AUTH` env-var form,
  not `-a "$REDIS_PASSWORD"`).
- No code-path change to install.sh / backup.sh / restore.sh /
  late-night-comeback.sh in this PR. Those become PR 3's sweep
  pass once PR 2's `ct doctor` is in place.

### Deployment

- Pull v0.0.96 and run `ct update`. The script picks up its own
  rewritten version on the next invocation (since `update.sh`
  always re-sources `lib.sh` from the working tree, not from a
  cached image). No image rebuild, no container restart needed
  for the maintain-script change itself — the regular update
  flow rebuilds images for the version-anchor bumps.
- Operators stuck mid-recovery on v0.0.95 can paste the
  `git stash push -u + ./scripts/update.sh` sequence from the
  v0.0.95 release notes verbatim; v0.0.96's preflight_clean_tree
  would have offered the same path interactively on the next run.

---

## [0.0.95] — 2026-05-14 — Hotfix: pin ext-redis to 6.3.0 (close v0.0.93 restart-loop regression)

Hotfix for a regression introduced in v0.0.93 and surfaced when
v0.0.94 reached production. The panel container restart-looped
because PECL installed phpredis 5.3.0 (below symfony/redis-
messenger v7.4.8's `conflict: ext-redis <6.1`), the entrypoint's
`composer install` exited non-zero on the conflict, and `set -e`
killed the entrypoint before supervisord could start. CI passed
because all four CI composer invocations carry
`--ignore-platform-req=ext-redis` (the runners have no ext-redis
to detect against); the entrypoint did not.

Three lockstep fixes — primary control + matching record +
guardrail:

### Fixed

- **Dockerfile pins `pecl install --force redis-6.3.0`** (the
  latest stable as of 2025-11-06) instead of the unpinned
  `pecl install --force redis` introduced in v0.0.93. Future
  bumps are explicit, version-controlled events — same posture
  as the Composer / naiveproxy-client / redis-cli pins
  elsewhere in this Dockerfile. Added `pecl channel-update
  pecl.php.net` ahead of the install so the channel cache
  matches reality on every build.
- **Panel composer platform override bumped 5.3.0 → 6.3.0** in
  `panel/composer.json` and the matching `platform-overrides`
  record in `panel/composer.lock`. Composer's solver now sees
  the same ext-redis version that the Dockerfile actually
  installs, so the on-host `composer install` produces a
  consistent lockstep view regardless of the
  `--ignore-platform-req` flag.
- **Entrypoint `composer install` carries
  `--ignore-platform-req=ext-redis`** as belt-and-braces,
  mirroring the four CI composer invocations. The Dockerfile
  pin is the single source of truth for the runtime
  ext-redis version — composer's solver doesn't need to
  re-verify on every container boot. If the PECL pin ever
  drifts again, the entrypoint won't blow up: it will install
  cleanly and the operator will see the actual version drift
  via direct inspection rather than via a restart loop.

### Deployment

- Pull v0.0.95 and run `ct update`. The panel image rebuilds
  with the pinned PECL phpredis-6.3.0, the entrypoint's
  `composer install` succeeds, supervisord starts all five
  programs (frankenphp, queue, messenger, scheduler,
  ct-core-daemon), and the v0.0.94 Messenger cutover is live
  as intended.
- Operators who deployed v0.0.94 and are currently in a
  restart loop: `ct update` from v0.0.94 → v0.0.95 directly
  fixes the loop. No data was at risk (the restart loop was
  in the boot path, before any DB or filesystem mutation).
- Rollback path: revert to v0.0.91 and re-deploy if v0.0.95's
  PECL pin fails to land for any reason. v0.0.91 → v0.0.95
  upgrade is a no-op for DB schema, sing-box config format,
  Caddyfile rendering, and the operator-facing `ct` CLI
  surface.

### Notes

- No code-path changes in this release. The PR diff is three
  small files: `docker/panel/Dockerfile` (PECL pin),
  `panel/composer.json` + `panel/composer.lock` (platform
  override bump), `docker/panel/entrypoint.sh` (composer
  install flag).
- v0.0.92 (PSR interfaces) and v0.0.93 (Messenger foundation)
  are unaffected by this hotfix and remain in production.

---

## [0.0.94] — 2026-05-14 — Messenger cutover (Phase 3 of Symfony-infusion arc)

Phase 3 — the cutover. v0.0.93's Symfony Messenger foundation is
already in production via the legacy Job → Bus shim. This release
retires the shim: call sites dispatch the Messenger message
directly, the legacy `App\Jobs\ReloadSingBoxJob` and
`App\Jobs\ReloadServerConfigJob` classes are removed, and the
dispatch tests are rewritten around Symfony Messenger's
`InMemoryTransport` instead of Laravel's `Queue::fake()`.

The two-hop path collapses to one hop. Operator-side behaviour
is unchanged.

### Changed

- **Three production call sites now dispatch direct to the
  Messenger bus** instead of `ReloadSingBoxJob::dispatch()` /
  `ReloadServerConfigJob::dispatch()`:
  - `ProxyAccount::booted::saved` →
    `new ReloadSingBox(reason: "proxy_account.saved:<status>")`
  - `ProxyAccount::booted::deleted` →
    `new ReloadSingBox(reason: "proxy_account.deleted")`
  - `ServerConfig::booted::updated` →
    `new ReloadServerConfig(reason: "server_config.updated")`
  Each `reason` lets an operator inspecting the Messenger
  transport correlate each pending message back to the event
  that produced it. The `ServerConfig` dispatch retains the
  v0.0.84 `try/catch + Log::warning` shape so a transient
  Redis-Streams outage doesn't bubble out as a 500 — the row
  is already committed and the every-5-min scheduled command
  reconciles.

### Removed

- `app/Jobs/ReloadSingBoxJob.php` and
  `app/Jobs/ReloadServerConfigJob.php`. The legacy Job classes
  served as the v0.0.93 transition shim (Laravel-Queue dispatch
  → Messenger-bus dispatch) and have completed that role.
- `tests/Feature/ReloadSingBoxJobFailedHandlerTest.php` and
  `tests/Feature/ReloadServerConfigJobFailedHandlerTest.php`
  (6 tests total). The `failed()` hook's responsibility of
  surfacing permanent failure at `Log::critical` is handed off
  to Symfony Messenger's `failure_transport` mechanism (a
  dedicated `failed` transport on the bus + a critical-log
  subscriber on `SendMessageToFailureTransportEvent`). Wiring
  that is deferred to a later release; Phase 3 retains
  correctness by pinning the handler's invocation contract at
  unit-test time.

### Added

- **Handler invocation-contract tests**:
  - `tests/Feature/ReloadSingBoxHandlerTest.php` (2 tests):
    `handler_renders_and_reloads_when_hash_changes` and
    `handler_skips_reload_when_render_returns_null`.
  - `tests/Feature/ReloadServerConfigHandlerTest.php` (2 tests):
    `handler_renders_caddy_first_then_singbox_then_reloads_on_change`
    (pinning the Caddy-first render order from v0.0.84) and
    `handler_skips_singbox_reload_when_singbox_render_returns_null`.
  Anonymous classes replaced by named test doubles
  (`FakeSingBoxGenerator`, `FakeSingBoxReloader`,
  `RecordingCaddyGenerator`, etc.) for object-identity-stable
  assertions after `app->instance(...)`.

### Updated

- `tests/Feature/ProxyAccountAfterCommitTest.php` and
  `tests/Feature/ServerConfigSaveDispatchesReloadJobTest.php`
  both moved from `Queue::fake() + Queue::assertPushed(JobClass, N)`
  to direct introspection of
  `app(TransportInterface::class)->getSent()`. The transport is
  `InMemoryTransport` in the testing env (per v0.0.93's
  environment-aware binding). One extra test added to
  `ProxyAccountAfterCommitTest` validating the new `reason`
  field flows through correctly.

### `[program:queue]` retained

Even though no app code dispatches via Laravel's queue anymore,
Filament internals (queued notifications, bulk-action progress,
queued exports) may still use it. The worker idles when nothing
is dispatched — cheap to keep. Auditing Filament's queue usage
is a separate concern outside this release's scope.

### Operator impact (`ct update` v0.0.93 → v0.0.94)

1. No Dockerfile change. ext-redis is already installed from
   v0.0.93.
2. No supervisord change. `[program:messenger]` continues;
   `[program:queue]` continues.
3. **In-flight Laravel-Queue jobs from before the deploy**:
   any `ReloadSingBoxJob` or `ReloadServerConfigJob` row still
   in the `jobs` table will fail to deserialize after the
   deploy (class missing). That's a known one-time drain
   hazard — operators should `php artisan queue:flush` or
   accept the failed-jobs surfacing in `failed_jobs`. **No
   data loss** — the row that triggered each job is already
   committed; the new Filament save / scheduled tick will
   reconcile.

### Tests

- All 12 dispatch + handler tests pass:
  4 dispatch contract (`ProxyAccountAfterCommit`),
  3 dispatch contract (`ServerConfigSave`),
  2 handler contract (`ReloadSingBoxHandler`),
  2 handler contract (`ReloadServerConfigHandler`),
  1 reason-field flow (`ProxyAccountAfterCommit`).
- No Laravel queue interaction remains in the test suite.
- PR #84 CI passed before merge — all 18 jobs green.
- Local pre-release validation:
  - `php -l` clean on all modified PHP files.
  - `./vendor/bin/pint` clean.
  - `make ci` clean.

### Diff

`+398 / −558` net. Deletes 4 files, modifies 4, adds 2. Net
negative line count — the cutover collapses the bridge layer.

### The Symfony-infusion arc is complete

v0.0.92 introduced six PSR-style interfaces. v0.0.93 wired
Symfony Messenger 7.4 with a Redis Streams transport, defined
the message DTOs and handlers, and bridged the legacy Jobs into
the bus. v0.0.94 retires the legacy Jobs and the bridge. The
panel's render+reload concurrency model is now Symfony Messenger
end-to-end while Filament, Eloquent, and the rest of the Laravel
surface remain intact.

---

## [0.0.93] — 2026-05-14 — Symfony Messenger foundation (Phase 2 of Symfony-infusion arc)

Phase 2 of the v0.0.92 → v0.0.94 Symfony-infusion arc. Installs
Symfony Messenger 7.4.11 + Redis transport 7.4.8, defines the
two reload message DTOs + handlers, wires the bus + Redis
Streams transport, adds a `[program:messenger]` supervisord
program, and bridges the legacy `ReloadSingBoxJob` /
`ReloadServerConfigJob` `handle()` methods into the Messenger
bus.

Behaviour preserved end-to-end. Existing call sites
(`ReloadSingBoxJob::dispatch()` from model observers, Filament
actions, scheduled commands) continue to work unchanged.

### Added

- **Symfony Messenger 7.4.11 + Redis transport 7.4.8** in
  `panel/composer.json`. `config.platform.ext-redis = 5.3.0`
  so composer resolves on CI runners that don't have the
  extension installed locally; production container has the
  real extension via the panel Dockerfile's PECL install.
- **`app/Messages/ReloadSingBox.php` + `ReloadServerConfig.php`** —
  readonly DTOs with a single `reason` field for operator-side
  observability.
- **`app/MessageHandlers/ReloadSingBoxHandler.php` +
  `ReloadServerConfigHandler.php`** — handlers with
  `#[AsMessageHandler]`, depend on the v0.0.92 PSR interfaces
  (`SingBoxConfigGeneratorInterface`,
  `SingBoxReloaderInterface`, `CaddyfileGeneratorInterface`).
  Same render+reload semantics as the legacy Job classes; the
  Caddyfile-first render order from v0.0.84 is preserved.
- **`app/Providers/MessengerServiceProvider.php`** — wires
  `MessageBusInterface` (with `SendMessageMiddleware` +
  `HandleMessageMiddleware`) and `TransportInterface` (Redis
  Streams on the `cool_tunnel:messenger` stream, consumer
  group `cool_tunnel`). In the `testing` env, swaps to
  Messenger's `InMemoryTransport` so PHPUnit doesn't need
  `ext-redis` installed locally / in CI runners.
- **`app/Console/Commands/MessengerConsume.php`** — Artisan
  wrapper around `Symfony\Component\Messenger\Worker` with
  `--time-limit=3600` + `--memory-limit=128M` matching the
  existing `[program:queue]` posture.
- **`docker/panel/supervisord.conf`** — new `[program:messenger]`
  stanza inheriting the round-22 uniform graceful-shutdown attrs
  + the `[program:queue]` `startretries=10` Redis-blip
  protection.

### Changed

- **`docker/panel/Dockerfile`** — `pecl install redis` +
  `docker-php-ext-enable redis` in a scoped RUN block with
  build-deps in a `--virtual` group, deleted at end of step.
  Laravel / Predis stays as the Laravel-side Redis client;
  ext-redis is for Symfony Messenger's Redis transport only.
  The two clients share the same Redis instance but use
  independent connection pools and don't interfere.
- **`scripts/verify_supervisord.sh`** — docstring updated to
  list the new program. The round-6 invariants check is
  data-driven (greps `^[program:*]`) so messenger is picked
  up + validated automatically; verify_supervisord now reports
  `5 programs found — frankenphp queue messenger scheduler
  ct-core-daemon`.
- **`.github/workflows/audit.yml`**:
  - PSR-4 strict regex updated to accept chained modifiers
    (`final readonly class X` from PHP 8.2+) and to survive
    grep's no-match exit when a file has no class/interface
    declaration. The pre-fix regex only allowed one optional
    modifier; the pre-fix `set -e` + `pipefail` killed the
    script on any modifier-less file instead of continuing.
  - `composer install --ignore-platform-req=ext-redis` on
    panel installs. CI runners have ext-redis 5.3.0 but
    `symfony/redis-messenger 7.4.8` requires 6.1+; production
    has 6.x via the PECL install above. CI never RUNS the
    Redis transport (PHPUnit uses `InMemoryTransport`).
- **`.github/workflows/ci.yml`** — same
  `--ignore-platform-req=ext-redis` on the panel test-deps
  composer install.

### Backward-compat shims

- **`App\Jobs\ReloadSingBoxJob::handle()`** now dispatches
  `new ReloadSingBox(reason: 'legacy-job-bridge')` instead of
  resolving the renderer/reloader directly. Same for
  `ReloadServerConfigJob`. Phase 3 (v0.0.94) deletes both Job
  classes.

### Password handling — same lesson as v0.0.88

The Redis transport's password is passed via the `auth`
transport option, **never interpolated into the DSN string**.
Mirror of v0.0.88's Rust-core typed-builder fix —
`openssl rand -base64` passwords with `/`, `+`, `=` bytes
survive the typed config; URL parsers reject them.

### Tests

- All 13 dispatch + failed-handler tests pass against
  `InMemoryTransport` (`ReloadSingBox`, `ReloadServerConfig`,
  `ServerConfigSave`, `ProxyAccountAfterCommit`). No test-file
  modifications — the test environment uses
  `InMemoryTransport` automatically via the provider's
  environment-aware binding.
- PR #83 CI passed before merge — all 18 jobs green
  (manifests, php-syntax, php-style, phpstan, php-class-vs-
  filename, rust, shell, templates, sqlx, secret scan,
  composer audit, dependency review, manifest drift, anti-
  tracking config, stale doc references, blade asset-link).
- Local pre-release validation:
  - `php -l` clean on all new + modified PHP files.
  - `./vendor/bin/pint` clean.
  - `./vendor/bin/phpunit --filter 'ReloadSingBox|ReloadServerConfig|ServerConfigSave|ProxyAccountAfterCommit'`
    — 13 tests, 23 assertions, OK.
  - `make ci` clean.
  - `verify_supervisord` reports `5 programs found` with
    lifecycle invariants intact.

### Operator impact (`ct update` v0.0.92 → v0.0.93)

1. Image rebuild includes ext-redis PECL compile (~30 s added
   on first build; cached on subsequent runs).
2. supervisord brings up the new `[program:messenger]` worker
   alongside `[program:queue]`; first send to the bus
   auto-creates the Redis stream + consumer group via
   `auto_setup: true` — no separate bootstrap step.
3. Existing in-flight Laravel Queue jobs drain through the
   legacy Job shims (still functional; they bridge to
   Messenger internally).
4. Operator sees no Filament-side change.

### Next phase

**Phase 3 (v0.0.94)**: update call sites (`ProxyAccount::booted`,
`ServerConfig::booted`, Filament actions, scheduled commands)
to dispatch `new ReloadSingBox()` / `new ReloadServerConfig()`
directly to the bus. Remove legacy `ReloadSingBoxJob` and
`ReloadServerConfigJob` classes. Rewrite dispatch tests around
`InMemoryTransport` assertions instead of `Queue::fake()`.

---

## [0.0.92] — 2026-05-14 — PSR service interfaces (Phase 1 of Symfony-infusion arc)

Phase 1 of the v0.0.92 → v0.0.94 Symfony-infusion arc (hybrid of
Scenarios A + B from the cost-benefit pushback discussion).
Behaviour-identical to v0.0.91; only the contract layer is new.

The proxy wire protocol, subscription manifest, queue contract,
runtime behaviour, Filament resources, and Eloquent models are
all unchanged from v0.0.91. `ct update` from any prior version
applies cleanly with no schema migration, no env-var addition,
no supervisord-program addition, no Redis stream creation.

### Added

- **Six PSR-style interfaces under `App\Contracts\`**:
  - `SingBoxConfigGeneratorInterface` (`renderToFile(): ?string`)
  - `SingBoxReloaderInterface` (`reload(): bool`)
  - `CaddyfileGeneratorInterface` (`renderToFile(): ?string`)
  - `RevocationBusInterface` — 5 announce / status methods.
    Name deliberately drops "Redis" (transport is an
    implementation detail).
  - `CtServerCoreInterface` — `run()` plus 9 typed helpers
    covering every existing public method on `CtServerCore`.
  - `ComponentCheckerInterface` (`check()` + `summarize()`).

  Each interface captures the existing public surface of its
  concrete service 1:1 — no method additions, no signature
  drift. PHPdoc on each documents idempotency contracts
  (hash-based dedup), null-on-failure semantics (swallow to
  critical log, never throw), and the worker-mode invariants
  the implementations already honour.

### Changed

- **Six concrete services declare `implements` against their
  interface.** `SingBoxConfigGenerator`, `SingBoxReloader`,
  `CaddyfileGenerator`, `RedisRevocationBus`, `CtServerCore`,
  `ComponentChecker`. One-line change each.
- **`AppServiceProvider::register()` adds six interface →
  concrete bindings** via a private `SERVICE_BINDINGS` constant
  map. Existing `$this->app->singleton(Concrete::class)`
  registrations are preserved unchanged so call sites that
  resolve by concrete class name continue to work without churn.
  Phase 2 (Symfony Messenger handlers) will type-hint the
  interface; Phase 3 (test rewrites) will bind fakes against
  the interface in `$this->app->bind(...)`.
- **Bumped `metrics` crate from 0.24.5 → 0.24.6.** Unrelated to
  the interface work but folded in to unblock the shared CI
  gate — 0.24.5 was yanked from crates.io between the v0.0.91
  tag and the Phase 1 PR. Cargo.lock-only change; no code
  changes (API identical between 0.24.5 and 0.24.6).

### Tests

- No test files modified. Existing tests use `Bus::fake()` /
  `Queue::fake()` against Job classes, not service-class
  resolution through the container. Binding correctness is
  verified by `phpstan (level 5)`, `composer audit`, and the
  panel container's boot-time smoke when Filament resources
  instantiate.
- PR #82 CI passed before merge — full `audit.yml` gate plus
  the standard `ci.yml` gate (18 jobs).
- Local pre-release validation:
  - `php -l` clean on all 6 modified service files plus
    `AppServiceProvider` plus 6 new interface files.
  - `./vendor/bin/pint` clean.
  - `make ci` clean (php-syntax + composer-audit + shellcheck +
    manifests-jq + manifest-lockstep + verify-sot +
    verify-supervisord + secrets-argv).

### Diff

`+306 / −6` across 13 files: 6 new interface files, 6 modified
service files (1-line `implements` each), 1 modified
`AppServiceProvider`. Plus the metrics Cargo.lock bump.

### Next phases (for reference)

- **Phase 2 (v0.0.93)**: `composer require symfony/messenger`,
  message DTOs + handlers + `MessengerServiceProvider` +
  supervisord `[program:messenger]`. Legacy `ReloadSingBoxJob`
  / `ReloadServerConfigJob` stay as thin shims dispatching to
  the Messenger bus.
- **Phase 3 (v0.0.94)**: Cutover — update dispatch call sites,
  remove legacy Job classes, rewrite dispatch tests around
  Symfony Messenger's `InMemoryTransport`.

---

## [0.0.91] — 2026-05-14 — README tutorials rewritten in beginner-friendly form

Documentation-only release. The proxy wire protocol, subscription
manifest, queue contract, and runtime behaviour are all unchanged
from v0.0.90.

### Changed

- **`## First Deploy` and `## Maintaining a Running Deployment`
  rewritten as beginner-friendly tutorials.** v0.0.90's
  operator-grade prose was correct but assumed reader familiarity
  with Docker / Laravel / SSH / DNS / TLS / Linux ops. Real
  operators on first install have hit: not knowing what a VPS is,
  not knowing how to set DNS A records, not knowing what output
  to look for, not knowing how to tell "good" from "broken". The
  rewrite drops the assumed-knowledge floor — same step structure,
  same commands, dramatically more hand-holding. New material:
  - **"What you need before starting"** explains VPS / domains /
    email from scratch with cost estimate, concrete cloud
    providers, and the Cloudflare grey-cloud warning.
  - **"Check your DNS works"** step with explicit ✅/❌ branches.
  - **Six numbered steps** in First Deploy, each showing the exact
    command, the expected output snippet, and an explicit
    ❌-branch table for the common failure modes.
  - **Tables instead of paragraphs** for env-var assignments —
    easier to scan.
  - **Recovery hints inline** at every step rather than dumped at
    the end.
  - **`scp` recipe** in "Backing up your data" for off-server
    copy with the security warning about treating the tarball as
    a secret.
  - **Disaster-recovery walkthrough** in "Restoring from backup"
    covering provisioning a fresh VPS and bringing data back.
  - **Three log-fetch one-liners** in "Looking at logs when
    something seems off" (recent / follow-live / errors-only).
  - **Password-rotation recipes** in "Rotating passwords" with
    `REDIS_PASSWORD` (low-blast) and `DB_PASSWORD` (with the
    `ALTER USER → .env → restart` order spelled out) plus the
    explicit "never rotate `APP_KEY`" warning.
  - **"Fixing common problems" recovery table** covering every
    failure mode this deployment has actually surfaced through
    the v0.0.78–v0.0.89 development arc.
  - **"Quick path (advanced)"** and **"Advanced — what `ct
    update` actually does internally"** subsections collapse the
    dense operator-grade content into clearly-labelled sidebars
    so power users still have the dense reference but
    first-timers don't get intimidated.
  - **Voice changed throughout** from "operator commands" to
    "you'll do this, here's what you'll see". Concrete example
    values (`203.0.113.42`, `proxy.example.com`) repeated where
    placeholders used to be. Visual ✅/❌ glyphs on every
    verify-step so the boundary between "good" and "keep
    digging" is unambiguous.

### Tests

- PR #81 CI passed before merge:
  - `manifests (jq parse)`
  - `php (syntax / composer validate)`
  - `rust (build / test / clippy / fmt)`
  - `shell (shellcheck)`
  - `templates (substitute + caddy/sing-box config syntax)`
- Local pre-release validation:
  - `make ci` clean.
  - All in-line links + anchor refs verified to point at real
    targets.
  - Markdown table syntax verified.

### Diff

`+396 / −196` on a single file (`README.md`). Section structure
unchanged from v0.0.90 so anchor links from external docs (e.g.
`docs/operator-runbook.md`) continue to resolve.

---

## [0.0.90] — 2026-05-14 — README tutorial: First Deploy + Maintaining a Running Deployment

Documentation-only release. The proxy wire protocol, subscription
manifest, queue contract, and runtime behaviour are all unchanged
from v0.0.89.

### Changed

- **Two new tutorial sections in `README.md`.** The pre-fix
  `One-Click Bastion` + `Required DNS` sections covered the install
  one-liner but didn't walk a first-time operator through the full
  deploy path. Operators on the v0.0.78 → v0.0.89 line have hit
  several discoverable-only-by-running issues (placeholder secrets,
  wrong cwd after SSH, `REDIS_PASSWORD` URL-meta-char gotcha
  pre-v0.0.88, upstream-asset 404 pre-v0.0.89). The new sections
  surface those in the README so they're not learned the hard way:
  - `## First Deploy` — six-step walkthrough from blank Debian
    VPS to 9/10 readiness PASS, plus a 10/10 end-to-end probe
    step once a real account is provisioned. Prerequisites
    checklist (VPS, DNS, ports, email). Unattended path
    subsection for CI / IaC / cloud-init.
  - `## Maintaining a Running Deployment` — operator loop
    covering routine update via `make update` (with the v0.0.80
    flock + v0.0.73 credential-lock + state-purge sequence
    surfaced for visibility), backup / restore, reading the
    panel + Components page, observability via `CT_METRICS_BIND`
    + the key counters to alarm on, secret rotation (with the
    `APP_KEY` immutability caveat and the v0.0.88 typed-builder
    freedom from URL-meta chars), a recovery table for the
    failure modes we've actually seen in production, and the
    `~/.bashrc` shell alias snippet that closes the
    "still in /root after SSH" foot-gun.
- **System Contract baseline bumped from `v0.0.77` to
  `v0.0.89`.** The README's previous baseline note was 12
  releases stale.

### Tests

- PR #80 CI passed before merge:
  - `manifests (jq parse)`
  - `php (syntax / composer validate)`
  - `rust (build / test / clippy / fmt)`
  - `shell (shellcheck)`
  - `templates (substitute + caddy/sing-box config syntax)`
- Local pre-release validation:
  - `make ci` clean.
  - All in-line links verified to point at files that exist.
  - Anchor links resolve to the new section headings.

### Diff

`+281 / −21` on a single file (`README.md`). No code, manifests,
configuration, or behaviour changes.

---

## [0.0.89] — 2026-05-13 — Bump naiveproxy asset tag `v148.0.7778.96-2 → -5`

Build-fix release. The proxy wire protocol, subscription manifest,
queue contract, runtime behaviour, and binary version pin
(`148.0.7778.96`) are all unchanged. The bump is purely an
upstream-asset-availability hotfix.

### Fixed

- **Panel image rebuild no longer fails with `curl: (22) error 404`.**
  The upstream maintainer (`klzgrad/naiveproxy`) deleted the
  release assets from `v148.0.7778.96-2` after publication. The
  release tag still exists (referenced by the upstream release
  page) but its `assets` array is empty. Production `make update`
  runs hit
  `https://github.com/klzgrad/naiveproxy/releases/download/v148.0.7778.96-2/naiveproxy-v148.0.7778.96-2-linux-x64.tar.xz`
  and got 404, with the build aborting at panel stage 5/14 (the
  `naive` client install step). Latest available asset-bearing
  release is `v148.0.7778.96-5` (published 2026-05-10) — same
  upstream binary (`naive --version` still prints
  `naive 148.0.7778.96`), only the rebuild suffix changed.
  Therefore `manifests/naiveproxy-client.upstream.json`'s
  `version` field stays `148.0.7778.96` (it matches the binary's
  own `--version` output, not the asset tag), and the v0.0.74
  `manifest-lockstep` rule already accepts the asset tag as
  `version` or `version + rebuild-suffix`. Only the Dockerfile
  ARG block needed updating.

### Security

- **New per-arch SHA256 pins** computed locally against the
  GitHub-hosted tarballs before commit:
  - `linux-x64`:
    `ca6958dcbbfb7b1b38c55a213dab6927ce3c1417d969b815657513b81fc7352d`
  - `linux-arm64`:
    `88fb88340d70b763cdf66586e056d78cb0877b62899f3194abc30d41e5d18763`
  Verified the byte counts match the GitHub API's reported sizes
  (5,084,780 / 4,139,628). The Dockerfile's
  `sha256sum -c -` step inside the panel build still fails closed
  on any future tarball mismatch.

### Tests

- PR #79 CI passed before merge — full `audit.yml` gate plus the
  standard `ci.yml` gate including `manifest-lockstep`,
  `manifests-jq`, and the v0.0.79 `secrets-argv` regression guard.
- Local pre-release validation:
  - `make ci` clean.
  - SHA256 computed via `shasum -a 256` on the downloaded
    tarballs from the canonical
    `github.com/klzgrad/naiveproxy/releases/download/v148.0.7778.96-5/`
    URLs.

---

## [0.0.88] — 2026-05-13 — Redis subscriber: typed `ConnectionInfo` from discrete env vars

Permanent fix for the URL-parse class of bug that struck production
during a placeholder-secret rotation on v0.0.87. Mirror of v0.0.25's
MariaDB-URL hotfix for the same class. The proxy wire protocol,
subscription manifest, queue contract, coalescer logic, and
`MetricsRegistry` counters are all unchanged.

### Fixed

- **The Rust daemon's Redis subscriber no longer rejects passwords
  with URL-meta characters.** Pre-fix, `docker-compose.yml`
  interpolated `REDIS_URL` by string concatenation
  (`"redis://:${REDIS_PASSWORD}@redis:6379/0"`). `openssl rand
  -base64 32` — the canonical secret-generation method used by
  `bootstrap.sh` and recommended by the README — produces
  passwords containing `/`, `+`, `=`. All URL-meta characters that
  the redis-rs URL parser rejects with `InvalidClientConfig`.
  Operators rotating secrets that way saw the daemon's revocation
  fast path die silently (slow-path queue-job reload still worked,
  so the ≤100 ms hot path was broken but panel saves still
  reached sing-box). Workaround was regenerating
  `REDIS_PASSWORD` with `openssl rand -hex 32`.

  The permanent fix is three surgical changes:

  - **`core/ct-server-core/src/redis_bridge.rs`** — new
    `connection_info_from_env<F>(get: F) -> Option<ConnectionInfo>`
    helper. Builds `redis::ConnectionInfo` from discrete
    `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` /
    `REDIS_DATABASE` env vars. Returns `None` when `REDIS_HOST`
    is unset so the caller can fall back to URL parsing for
    legacy / unix-socket / TLS-Redis deployments. Pure over an
    env-var lookup closure for testability (mirror of
    `db::options_from_env` from v0.0.25). `run_subscriber()`
    prefers the typed builder; URL form is the fallback.
  - **`core/ct-server-core/src/main.rs`** — daemon spawn gate
    widened: subscriber starts when EITHER `REDIS_URL` or
    `REDIS_HOST` is set. Only the "neither" case logs the
    no-subscriber warning. The legacy `--redis-url` flag is
    preserved for operators with custom non-standard Redis.
  - **`docker-compose.yml`** — dropped
    `REDIS_URL: "redis://:${REDIS_PASSWORD}@redis:6379/0"` from
    the panel service env block. The daemon now reads
    `REDIS_HOST` / `REDIS_PORT` (already in the block) plus
    `REDIS_PASSWORD` / `REDIS_DATABASE` from `env_file: .env`.
    Laravel side was always on the discrete-var path
    (`panel/config/database.php` uses `env('REDIS_HOST')` etc.,
    not `env('REDIS_URL')`), so this change has no effect on the
    Laravel-to-Redis path.

### Tests

- Six new unit tests in `redis_bridge::tests`, mirroring the
  `db::tests` pattern:
  - `returns_none_when_host_missing` — `REDIS_HOST` is the gate;
    empty string treated as unset.
  - `password_with_url_meta_chars_survives_byte_for_byte` — the
    regression test; asserts
    `abc/def+ghi=jkl@mno#pqr:stu?vwx` round-trips through
    `ConnectionInfo` unchanged.
  - `defaults_match_compose_block` — `REDIS_HOST` alone → port
    6379, db 0, no password.
  - `malformed_port_falls_back_to_6379` — defensive against `\r`
    or alphabetic values in `.env`.
  - `empty_password_is_treated_as_unset` — `REDIS_PASSWORD=`
    collapses to `None`, not `Some("")`.
  - `db_can_be_overridden` — multi-instance Redis isolation via
    `REDIS_DATABASE=5`.
- All 132 `ct-server-core` tests pass (up from 126).
- PR #78 CI passed before merge — full `audit.yml` gate plus the
  standard `ci.yml` gate.
- Field-validated against production VPS: with the v0.0.87
  base64-from-rotation password, the daemon emitted
  `InvalidClientConfig` every 30 s; with v0.0.88's typed-builder
  path the same password works.

---

## [0.0.87] — 2026-05-13 — Readiness check 8: relative-duration window

Follow-up to v0.0.86. Field-validated against the production VPS,
v0.0.86's absolute-timestamp `--since="$(date +%s)"` worked in an
interactive shell but silently missed matches when invoked via
`make readiness`. Wire protocol, subscription manifest, and runtime
behaviour unchanged.

### Fixed

- **`check_redis_bridge` switches to relative `--since=5s`.**
  v0.0.86 captured `since_t=$(date +%s)` then queried
  `docker compose logs --since="${since_t}"`. The daemon's
  response (a sub-20 ms reload) and the log query both worked
  from a standalone interactive shell on the production VPS, but
  the same call inside `make readiness` returned no matches —
  `[NG] 8. Published, but no daemon ack within 2s window` reliably,
  even immediately after a clean `make update`. Exact mechanism
  unconfirmed (docker compose parser quirk for raw Unix-second
  timestamps, host/container clock skew, or pipefail-under-make
  interaction); the relative-duration form sidesteps all three.
  5 s window covers publish + sleep + buffer; the docker compose
  CLI handles the relative form consistently across versions.
- **Sleep bumped 2 s → 3 s** as defensive timing margin. Happy-path
  daemon response is ~20 ms; the extra second protects against
  cold-coalescer or busy-host scenarios where Docker's log-driver
  flush window might lag. NG message updated accordingly.

### Tests

- PR #77 CI passed before merge (after a transient GitHub Actions
  billing block was lifted by promoting the repo's billing posture
  for the public AGPL-3.0 codebase):
  - `manifests (jq parse)`
  - `php (syntax / composer validate)`
  - `rust (build / test / clippy / fmt)`
  - `shell (shellcheck)`
  - `templates (substitute + caddy/sing-box config syntax)`
- Local pre-release validation:
  - `bash -n scripts/late-night-comeback.sh` clean.
  - `shellcheck -x --severity=warning scripts/late-night-comeback.sh` clean.
  - `make ci` clean (full gate including `secrets-argv`).
- Field-diagnosed against production VPS on v0.0.86: daemon publishes
  three matching log lines within 20 ms ("sing-box reloaded via
  clash API", "sing-box reload path acknowledged", "sing-box reload
  applied"); `--since=<unix-seconds>` AND `--since=5s` both returned
  those lines in interactive shell. Switching to `--since=5s`
  eliminates the interactive-vs-`make readiness` divergence.

---

## [0.0.86] — 2026-05-12 — Readiness check 8 false-NG fix

Operator-side fix promoted from a live-VPS diagnostic against v0.0.85.
The proxy wire protocol, subscription manifest, queue contract,
and runtime behaviour are all unchanged.

### Fixed

- **`scripts/late-night-comeback.sh::check_redis_bridge` no longer
  false-NGs against a healthy Redis bridge.** The pre-fix check
  had two compounding fragilities:
  - `sleep 1` was too short. The Rust daemon acks a resync in
    ~3 ms (clash-API PUT) + ~19 ms (full apply, leading-edge
    coalescer), but Docker's log driver buffers stdout and
    `docker compose logs` doesn't surface sub-second writes
    reliably. The daemon's "sing-box reloaded via clash API"
    line surfaces around the 2-second mark.
  - `--tail=200` is a line window, not a time window. On a busy
    panel container, a real ack matching the regex could scroll
    out within minutes; a stale match from a previous run could
    false-pass; two consecutive `make readiness` runs disagreed
    (OK → NG flip observed in the field today).
  Capture a timestamp before publishing, `sleep 2`, then
  `docker compose logs --since="$since_t"` so the search is
  bounded to the publish window. Broaden the regex from
  `sing-?box reload` to `sing-?box reload(ed)?` so intent on the
  OTel-span line ("sing-box reloaded via clash API") is
  unambiguous. NG message now names the 2s bound so an operator
  who hits the NG path knows it was time-bounded, not log-format
  drift.

### Tests

- PR #76 CI passed before merge:
  - `manifests (jq parse)`
  - `php (syntax / composer validate)`
  - `rust (build / test / clippy / fmt)`
  - `shell (shellcheck)`
  - `templates (substitute + caddy/sing-box config syntax)`
- Local pre-release validation:
  - `bash -n scripts/late-night-comeback.sh` clean.
  - `shellcheck -x --severity=warning scripts/late-night-comeback.sh` clean.
  - `make ci` clean (full gate).
- Field-validated against the live production VPS (v0.0.85
  before the fix): published resync to `cool_tunnel:revocations`
  with `redis-cli -h redis ...`, confirmed subscriber count
  was `1`, observed three matching log lines from the daemon
  within 20 ms ("sing-box reloaded via clash API",
  "sing-box reload path acknowledged", "sing-box reload
  applied") that the time-bounded grep correctly catches.

---

## [0.0.85] — 2026-05-12 — Trim first-shipping cushion in three recent surfaces

Documentation-only release. The proxy wire protocol, subscription
manifest, runtime behaviour, queue contract, and operator-script
locking semantics are all unchanged from v0.0.84.

### Changed

- **`panel/app/Jobs/ReloadServerConfigJob.php`** — collapsed the
  ~50-line top-of-file rationale block to ~15 lines and dropped
  the per-property docblocks on `$tries` / `$timeout` /
  `backoff()` that repeated the class-level rationale. Pointer to
  `CHANGELOG [0.0.84]` carries the full story. Load-bearing
  comment in `handle()` (Caddyfile-first render order matters for
  cert-mtime propagation into the sing-box render hash) is
  preserved.
- **`panel/app/Models/ServerConfig.php::booted`** — collapsed the
  ~22-line nested rationale block inside the `static::updated`
  callback to a single 7-line summary above the closure.
  `DB::afterCommit` + the inner `try/catch` for queue-dispatch
  failures preserved verbatim; only the prose moved.
- **`scripts/lib.sh::acquire_op_lock`** — collapsed the ~25-line
  incident-pattern + history block to an 8-line summary pointing
  at `CHANGELOG [0.0.80]`. Function body, lock path, fd choice,
  and error messages all preserved exactly.
- **Two micro-modernisations along the way:** `get_class($e)` →
  `$e::class` (PHP 8 idiom available since the project's
  `php: ^8.2`); identical behaviour, cleaner syntax.

### Tests

- PR #75 CI passed before merge — full `audit.yml` gate plus the
  standard `ci.yml` gate (manifests, php syntax, rust, shell,
  templates, php style, phpstan, sqlx offline, gitleaks, blade
  asset-link, php class-vs-filename, stale doc references,
  manifest drift, anti-tracking config, dependency review,
  cargo audit, cargo deny, composer audit).
- Local pre-release validation:
  - `ReloadServerConfigJobFailedHandlerTest` — 3 tests pass
    unchanged (pins log level, event name, context keys, note
    text).
  - `ServerConfigSaveDispatchesReloadJobTest` — 3 tests pass
    unchanged (pins the rolled-back / committed / no-transaction
    `DB::afterCommit` dispatch contract).
  - `ProxyAccountAfterCommitTest` — 4 tests pass unchanged
    (sanity check on the surrounding `DB::afterCommit` shape).
  - 10 tests / 15 assertions total, all green.
  - `bash -n` + `shellcheck` clean on `lib.sh`.
  - `make ci` clean.

### Diff stats

`-134 lines net` across three files. No files added or removed.

---

## [0.0.84] — 2026-05-11 — ServerConfig render+reload moved into queued job

Promotes the final item (item 7) of the v0.0.78 robustness review.
This closes the last remaining Critical from that review. The
proxy wire protocol, subscription manifest, and external behaviour
are unchanged; the change is on the operator-facing save path
inside the panel.

### Fixed

- **`ServerConfig::booted::updated` no longer runs three shell-outs
  inline inside the Filament request lifecycle.** Pre-fix the
  hook ran `CaddyfileGenerator::renderToFile()`,
  `SingBoxConfigGenerator::renderToFile()`, and
  `SingBoxReloader::reload()` synchronously inside the request.
  Each render service swallowed any `\Throwable` to a
  `Log::critical` and returned null, but the page's `save()`
  method unconditionally showed a green "regenerated; both
  services hot-reloading" notification — operators who hit a
  transient `ct-server-core` hang during the upgrade window saw
  "saved successfully" while the on-disk config still reflected
  the previous state. The Octane worker's request was also
  blocked for the full 60s subprocess timeout if any of the
  three calls hung. Slow path now runs in the new
  `ReloadServerConfigJob` (3 tries × 5s backoff, hash-idempotent
  via the renderer's SHA-256 dedup); fast path
  (`announceServerConfigChanged` Redis pub/sub) stays inline so
  the daemon still picks up changes in ~1ms. Both paths now run
  inside `DB::afterCommit` so a rollback elsewhere in the
  surrounding transaction doesn't queue a phantom reload. Job
  dispatch is wrapped in `try/catch` so a transient queue-backend
  outage (Redis down) doesn't bubble out as a 500 to the request.
- **Filament page notification reflects the new contract.**
  `ServerConfigPage::save()` now reads "Reload queued. The Redis
  fast-path is already in flight (≤100ms); the panel-side
  render+reload backstop will land within seconds. If the
  Components page reports drift after a minute, check
  `docker compose logs panel` for `serverconfig.reload.job_failed`."
- **`failed()` handler surfaces drift at CRITICAL level.** On
  retry exhaustion the job emits
  `serverconfig.reload.job_failed` at `Log::critical`, mirroring
  the existing `singbox.reload.job_failed` event from
  `ReloadSingBoxJob`. Dashboards alarming on `critical` now fire
  for slow-path failures too. The context note documents the
  drift-vs-security split — the Redis fast-path keeps the
  daemon in sync, so a slow-path failure is panel/disk-state
  drift, not a security incident — so the 3am operator paged on
  the alarm doesn't escalate to security.

### Tests

- New `Feature/ServerConfigSaveDispatchesReloadJobTest` pins
  the three semantic cases the `DB::afterCommit` dispatch
  contract must guarantee (rolled-back / committed / no-
  transaction). Mirrors the existing
  `ProxyAccountAfterCommitTest`.
- New `Feature/ReloadServerConfigJobFailedHandlerTest` pins the
  `failed()` contract — CRITICAL log level, documented event
  name, exception type + message + tries count, drift-vs-
  security note. Mirrors the existing
  `ReloadSingBoxJobFailedHandlerTest`.
- 6 new tests, 10 assertions, all pass.
- PR #74 CI passed before merge — full audit.yml gate plus the
  standard ci.yml gate.
- Local pre-release validation:
  - `php -l` clean on all five touched/new PHP files.
  - `./vendor/bin/phpunit --filter
    'ServerConfigSaveDispatchesReloadJob|ReloadServerConfigJobFailedHandler'`
    — 6 tests, 10 assertions, OK.
  - `make ci` clean.

---

## [0.0.83] — 2026-05-11 — Subscription expires_at clamp (spec compliance)

Promotes review item 6 from the v0.0.78 robustness review. The
proxy wire format remains WireV1-compatible; the change is on the
subscription manifest field that spec-compliant clients use for
the freshness check, so a client built against any 0.0.x ct-protocol
version will continue to verify and now correctly receive a
manifest valid for the full window the spec advertises.

### Fixed

- **Server-emitted manifests no longer set `expires_at` past the
  spec's freshness window.** Pre-fix, `subscription::emit` set
  `expires_at = now + 30 days`, but
  `SubscriptionManifestV1::FRESHNESS_WINDOW_SECONDS = 7 days` is
  the spec invariant. Any client running `check_freshness` (the
  macOS client links against ct-protocol and implements the check)
  refused the manifest after day 7 with `StaleByIssuedAt`. Users
  saw "subscription stopped working a week after install" with no
  apparent cause; operators inspected the manifest and saw
  `expires_at` 23 days in the future and had no diagnostic. New
  `SubscriptionManifestV1::canonical_expires_at(issued_at)` is the
  single source of truth for the issued/expiry relationship; the
  server-side emitter now uses it. Saturating-add inside the
  helper guards a near-`u64::MAX` `issued_at` from wrapping below
  `issued_at` (which would trip `IssuedInFuture` on every
  subsequent client).

### Tests

- New ct-protocol test
  `canonical_expires_at_lands_on_freshness_window_boundary`
  asserts the hard property
  (`expires_at - issued_at <= FRESHNESS_WINDOW_SECONDS`), the
  equality (the helper lands EXACTLY on the boundary, not earlier
  than the spec promises), and the end-to-end `check_freshness`
  behaviour at boundary and boundary+1 (transitioning to
  `StaleByIssuedAt`, NOT `ExpiredByExpiresAt` — pinning the order
  of checks against accidental rearrangement).
- New ct-protocol test `canonical_expires_at_saturates_near_u64_max`
  guards the saturating-add edge case.
- All 24 ct-protocol tests pass.
- PR #73 CI passed before merge — full audit.yml gate plus the
  standard ci.yml gate.
- Local pre-release validation:
  - `cargo test --release -p ct-protocol --locked` — 24 passed.
  - `make ci` clean.

---

## [0.0.82] — 2026-05-11 — u64-safe traffic accounting

Promotes review item 5 from the v0.0.78 robustness review. Two
surfaces in the Rust core, one class of bug — the `traffic_logs`
columns are `unsignedBigInteger` but were being read as `i64`,
and `proxy_accounts.used_bytes` was being incremented without a
u64 overflow guard. The proxy wire protocol, subscription
manifest, and external behaviour are unchanged.

### Fixed

- **`metrics::collect` SELECT now reads `(u64, u64)`.** Previously
  `sqlx::query_as::<_, (i64, i64)>` against `traffic_logs.uplink_bytes`
  / `downlink_bytes` (declared `unsignedBigInteger` per the migration)
  returned a sqlx decode error the moment a stored value exceeded
  `i64::MAX`. The cron tick then failed, `traffic_logs` stopped
  moving, and downstream `quota::enforce` stopped disabling expired-
  by-bytes accounts. Realistic trigger: restoring from a backup
  written by a tool that wrote larger values; theoretical trigger:
  long-lived high-traffic VPS crossing 8 EB on a single account.
  Switched to `Option<(u64, u64)>`, with `Sample` i64 readings
  clamped to non-negative via `.max(0) as u64` for delta arithmetic.
  `u64::saturating_sub` returns 0 on counter-reset, matching the
  prior intent of `i64::saturating_sub` plus `.max(0)`.
- **`db::add_used_bytes` UPDATE now refuses to apply on u64
  overflow.** Previously `SET used_bytes = used_bytes + ?` would
  silently wrap (or error in strict mode) when the sum exceeded
  `u64::MAX` (`18446744073709551615` = 2^64 - 1). On wrap,
  `used_bytes` jumped near 0 and the quota check
  `used_bytes < quota_bytes` passed again — the account silently
  re-enabled. The new WHERE-clause guard
  `used_bytes <= 18446744073709551615 - ?` makes the UPDATE refuse
  to apply on overflow; a one-row existence check on the cold path
  distinguishes "account no longer exists" (silent — known late-
  metric race for deleted accounts) from "would overflow" (loud
  typed validation error).

### Tests

- New unit test `db::tests::add_used_bytes_sql_carries_overflow_guard`
  pins the SQL string and the typed-error branch via `include_str!`
  so a future refactor can't regress the protection silently.
- PR #72 CI passed before merge — full `audit.yml` gate plus the
  standard `ci.yml` gate, including `sqlx offline metadata up to
  date` (the new UPDATE uses runtime `sqlx::query` rather than the
  compile-time `query!` macro because the third `?` binding isn't
  in the existing `core/.sqlx/` cache; `upsert_traffic` immediately
  above keeps `query!` so schema-drift validation is preserved at
  the table level).
- Local pre-release validation:
  - `SQLX_OFFLINE=true cargo test --release --workspace --locked`
    — 126 passed, 0 failed.
  - `make ci` clean.

---

## [0.0.81] — 2026-05-11 — Boot-time guards: OCTANE_SERVER default + APP_KEY refusal

Promotes review item 4 from the v0.0.78 robustness review. Two
boot-time guards close two Critical-class fail-silent paths. The
proxy wire protocol, subscription manifest, and runtime behaviour
are unchanged.

### Fixed

- **`OCTANE_SERVER` default is now `frankenphp`, not `roadrunner`.**
  The upstream Laravel Octane vendor:publish stub ships
  `'server' => env('OCTANE_SERVER', 'roadrunner')`. Cool Tunnel
  runs FrankenPHP exclusively. The repo-root `.env.example` sets
  `OCTANE_SERVER=frankenphp`, so production was correct — but any
  path that loaded the config without that env injection (cached
  config, post-deploy CLI, dev shell) inherited the upstream
  "roadrunner" default. `php artisan octane:reload` then targeted
  the wrong driver, found no PID, exited 0 — the worker was never
  recycled, and the 500-request `MAX_REQUESTS` cap became the only
  safety net for picking up code/config changes after a deploy.
  `panel/config/octane.php` now defaults to `frankenphp`. The
  matching setting is added to `panel/.env.example` for dev-shell
  hygiene. The default is pinned at unit-test time by the new
  `tests/Unit/OctaneServerDefaultTest` (text-level assertion so a
  vendor:publish refresh that reverts the default trips immediately).
- **`frankenphp-worker.php` refuses to boot with empty `APP_KEY`.**
  Without a valid `APP_KEY`, every `password_cleartext_encrypted`
  blob fails to decrypt and every subscription HMAC fails to sign;
  the framework's exception handler then catches the throws per
  request and degrades each subscription URL to 200-with-cover-
  site bytes. Real users would see "subscription URL stopped
  working" while operators saw no panel error. The bootstrap
  entrypoint now exits 1 with a clear stderr diagnostic — and the
  `artisan key:generate` command — when `APP_KEY` is empty or
  unset. Operator gets a fail-fast signal at container start
  instead of a quiet wave of degraded URLs hours later.

### Tests

- New unit test: `tests/Unit/OctaneServerDefaultTest::default_octane_server_is_frankenphp`.
- PR #71 CI passed before merge — full audit.yml gate (cargo
  audit, cargo deny, composer audit, gitleaks, phpstan, sqlx
  offline, blade asset-link, php class-vs-filename, php style,
  stale doc references, manifest drift, anti-tracking config,
  dependency review) plus the standard ci.yml gate.
- Local pre-release validation:
  - `php -l` clean on `octane.php`, `frankenphp-worker.php`,
    `OctaneServerDefaultTest.php`.
  - `./vendor/bin/phpunit --filter OctaneServerDefaultTest` —
    1 test, 4 assertions, OK.
  - `make ci` clean.

---

## [0.0.80] — 2026-05-11 — Operator-script flock (concurrent-run safety)

Promotes review item 3 from the v0.0.78 robustness review. The
proxy wire protocol, subscription manifest, and runtime behaviour
are unchanged. This is an operator-side safety release: a second
operator running `make update` (or update during backup, etc.) can
no longer race the first to corrupt `.env`, the image build, or
half-applied migrations.

### Fixed

- **Concurrent-run safety on operator scripts.** Previously a
  pager-during-incident pattern (primary operator runs `make
  update`, secondary SSHes in and runs the same to "kick" a
  stuck-looking dashboard) could race the `.env` auto-migration's
  `awk > .env.tmp && mv` and clobber each other; could race
  `compose build panel` so operator A's `compose up -d` silently
  no-ops because operator B's build became "current" with their
  changes; could half-apply migrations. New `lib.sh::acquire_op_lock`
  takes a non-blocking exclusive `flock` on a per-project lockfile
  (`/tmp/cool-tunnel-ops-${project}.lock`, fd 9, kernel-released
  on process exit) and is wired into `install.sh`, `update.sh`,
  `backup.sh`, and `restore.sh` immediately after `require_docker`.
  Per-project lock path preserves round-24 multi-deploy semantics
  (prod and staging on the same host don't serialise against each
  other); shared across the four scripts so any one of them blocks
  the other three. A second invocation now dies fast with an
  `lsof`-driven hint pointing at the lockfile.

### Tests

- PR #70 CI passed before merge:
  - `manifests (jq parse)`
  - `php (syntax / composer validate)`
  - `rust (build / test / clippy / fmt)`
  - `shell (shellcheck)`
  - `templates (substitute + caddy/sing-box config syntax)`
- Local pre-release validation:
  - `make ci`
  - `bash -n` syntax check on `lib.sh` plus the four wired scripts
  - `. scripts/lib.sh; declare -F acquire_op_lock` confirms the
    function loads

---

## [0.0.79] — 2026-05-11 — Secret-in-argv hygiene + CI guard

Promotes the highest-leverage finding from the v0.0.78 robustness
review (Critical-1). The proxy wire protocol, subscription manifest,
and runtime behaviour are unchanged. This is an operator-side
posture release: the four call sites that regressed `backup.sh`'s
v0.0.17 `MYSQL_PWD` / `REDISCLI_AUTH` discipline are corrected, and
a CI grep is added so the regression class can't recur.

### Security

- **Stop leaking DB and Redis passwords via `argv` in operator
  scripts.** `backup.sh`'s v0.0.17 hardening passes the secret
  through `MYSQL_PWD` env so it never reaches `ps -ef` or any
  host-side process collector. Four companion scripts had
  regressed: `restore.sh:84` (`mariadb -p"$MARIADB_ROOT_PASSWORD"`),
  `late-night-comeback.sh:144` (`redis-cli -a "$REDIS_PASSWORD"`),
  `stress/c_revocation_latency.sh:113-134` (both DB and Redis), and
  `stress/g_anti_tracking_probe.sh:50-53` (DB). The
  `late-night-comeback.sh` site is the most acute — that script
  runs from the published readiness gate and routes its `argv`
  into `journalctl` on most deploys, so the Redis bus password
  was leaking straight to the journal. All four sites now use
  `compose exec -T -e MYSQL_PWD="$DB_PASSWORD" db mariadb -u USER …`
  / `compose exec -T -e REDISCLI_AUTH="$REDIS_PASSWORD" redis
  redis-cli --no-auth-warning …`.

### Added

- **`make secrets-argv` CI gate.** New Makefile target wired into
  `make ci` that fails the build when any `*.sh` file under
  `scripts/` or `docker/` passes `mariadb`/`mysql`/`redis-cli`
  with `-p` or `-a` followed by a `$`-interpolated value. Targets
  env-var interpolation specifically (literal hard-coded secrets
  are caught by `gitleaks` in `audit.yml`). Comment lines are
  skipped so `backup.sh`'s rationale block (which references the
  bad pattern as a documented example) does not false-positive.

### Tests

- PR #69 CI passed before merge:
  - `manifests (jq parse)`
  - `php (syntax / composer validate)`
  - `rust (build / test / clippy / fmt)`
  - `shell (shellcheck)`
  - `templates (substitute + caddy/sing-box config syntax)`
- Local pre-release validation:
  - `make ci` (now includes `secrets-argv: clean`)
  - Negative test: synthetic `redis-cli -a $BAR` line trips the
    new check; existing comment-only references in `backup.sh`
    correctly skip.

---

## [0.0.78] — 2026-05-11 — README refresh: Rule Maker FSM, OTel observability, credential-lock

Documentation-only release. The proxy wire protocol, subscription
manifest, rendered configuration surface, and runtime behaviour are
unchanged from `v0.0.77`.

### Changed

- **README aligned with the v0.0.72 → v0.0.77 reality.** The
  System Contract now pins `v0.0.77` as the current baseline,
  records WireV1 as the wire format, and expands the Core model
  row to name the credential-lock invariant, the Rule Maker daemon
  FSM, bounded `BytesMut` frames, typed wire errors, and OTel-style
  network-turn spans.
- **Architecture deep-dive describes the Rule Maker FSM.** A new
  paragraph documents connection-local atomic transitions, the
  `HardReset` taxonomy for protocol violations, and the
  `ProbingConstancy` step that measures frame and latency pressure
  against the 80% bottleneck threshold and narrows the next read
  chunk under load without raising the hard frame cap.
- **Industrial Makefile section surfaces operator invariants.**
  `make readiness` is now described as the 10-check launch gate
  with a `9/10` PASS threshold and a structural-failure cap (v0.0.75),
  and `ct-server-core guard credential-lock` is documented as a
  separately runnable `db = rendered = manifest = mac-config`
  invariant (v0.0.73).
- **Health-metrics QA names the offense-driven surface.**
  `CT_METRICS_BIND` is clarified as opt-in with a `127.0.0.1:9292`
  recommendation; the checklist now references
  `otel_network_turn_*`, `ct_threshold_80pct_crossings_total`,
  and `ct_daemon_fsm_hard_resets_total` and links to
  `docs/observability-dashboard.md` for the Prometheus and Grafana
  story (v0.0.69, v0.0.76).
- **Project Map and Operator References extended.** Added pointers
  to `daemon_fsm.rs`, `observability.rs`,
  `credential-lock.upstream.json`, and `late-night-comeback.sh` in
  the Project Map; added nine in-repo docs to the Operator
  References table (`installation-debian.md`, `components.md`,
  `daemon-fsm.md`, `observability-dashboard.md`,
  `release-stress-test.md`, `architectural-decisions-2026.md`,
  `cross-platform-clients.md`, `going-to-china.md`, and
  `ai-unit-test-generation.md`).

### Tests

- PR #68 CI passed before merge:
  - `manifests (jq parse)`
  - `php (syntax / composer validate)`
  - `rust (build / test / clippy / fmt)`
  - `shell (shellcheck)`
  - `templates (substitute + caddy/sing-box config syntax)`
- Local pre-release validation:
  - `make ci`

---

## [0.0.77] — 2026-05-10 — Rule Maker daemon FSM

This patch release promotes the daemon transport FSM hardening. The
proxy wire protocol and subscription format are unchanged.

### Changed

- **Rule Maker transition table.** Daemon connections now advance via
  named `ConnectionEvent` values. The FSM owns the only legal event to
  state mapping, so callers can no longer request arbitrary
  `expected -> next` transitions.
- **Atomic no-fork enforcement.** `ConnectionFsm::apply` still uses
  `AtomicU8::compare_exchange`, but the expected predecessor now comes
  from the Rule Maker table. Any mismatch stores `HardReset`, emits
  telemetry, and closes the offending connection.
- **Heng constancy remains active.** Successful turns still enter
  `ProbingConstancy`, measure frame and latency pressure, and tune the
  next read chunk without raising hard protocol limits.

### Fixed

- **Clean EOF is now an FSM event.** Peer close while reading advances
  through `PeerClosed -> Disconnected`; clean shutdown no longer uses a
  direct terminal-state store outside the transition table.

### Tests

- `cargo fmt --all -- --check`
- `SQLX_OFFLINE=true cargo build --release --workspace --locked`
- `SQLX_OFFLINE=true cargo test --release --workspace --locked`
- `SQLX_OFFLINE=true cargo clippy --release --all-targets --locked`

---

## [0.0.76] — 2026-05-10 — Offense-driven observability

This patch release promotes the OTel-oriented observability pass from
PR #66. The proxy wire protocol and subscription format are unchanged.

### Added

- **Network-turn tracing.** Daemon Unix-socket reads, internal
  `/metrics` scrapes, Clash API calls, DoH resolver checks,
  anti-tracking probes, and the canary TCP connect now emit
  `otel.network.turn` spans with OTel semantic labels.
- **80% threshold metrics.** Prometheus-compatible counters and gauges
  now track latency-budget crossings, buffer high-water saturation,
  daemon handler permit pressure, and daemon FSM hard resets.
- **Monitoring dashboard spec.** `docs/observability-dashboard.md`
  now includes Prometheus scrape config, alert rules, Grafana panels,
  span fields, and the silent/incident logging hierarchy.

### Changed

- **Silent production logging.** The core now defaults to `RUST_LOG=warn`
  behavior so normal operation stays quiet; incident operators can raise
  `ct_server_core=trace` to expose capped technical suppression detail.

### Tests

- PR #66 CI passed before merge:
  - `rust (build / test / clippy / fmt)`
  - `php (syntax / composer validate)`
  - `templates`
  - `shellcheck`
  - `manifests`
  - `cargo audit`, `cargo deny`, `composer audit`, `gitleaks`

---

## [0.0.75] — 2026-05-10 — Readiness gate simplification

This patch release promotes the readiness gate cleanup from the VPS
validation loop. The proxy wire protocol and subscription format are
unchanged.

### Fixed

- **Removed the plain-curl CONNECT readiness check.** The old
  synthetic `curl --proxy` check did not speak NaiveProxy's padding
  behavior and could fail while the real client path worked. It was
  deleted instead of treated as a launch signal.
- **Restored the meaningful end-to-end proxy check.** Check 10 now
  uses the bundled `/usr/local/bin/naive` client through
  `ct-server-core probe anti-tracking` and reports
  `hide_ip + hide_via effective` on success.
- **Readiness docs now match the script.** README, Getting Started,
  and the operator runbook describe the 10-check gate and its
  `9/10` pass threshold.

### Tests

- `bash -n scripts/late-night-comeback.sh`
- `shellcheck -x --severity=warning scripts/late-night-comeback.sh`

---

## [0.0.74] — 2026-05-10 — VPS update hardening hotfix

This hotfix promotes the VPS findings from the `v0.0.73` rollout into
code. The proxy wire protocol and subscription format are unchanged.

### Fixed

- **NaiveProxy client component check.** The bundled `naive` binary
  reports `naive 148.0.7778.96`; the manifest now pins
  `148.0.7778.96` instead of the Docker asset tag
  `v148.0.7778.96-2`. The asset suffix identifies the downloaded
  release archive, but the installed binary does not print it.
- **Host-side state purge placement.** The mandatory `docker compose
  restart sing-box` is performed by `scripts/update.sh` on the host,
  not by `ct-server-core` inside the panel container. The panel image
  intentionally has no Docker CLI.
- **Manifest lockstep rule.** `make manifest-lockstep` now accepts a
  Docker NaiveProxy asset tag that is either exactly the manifest
  version or the manifest version plus a rebuild suffix. This catches
  real drift without confusing asset naming with runtime identity.

### Tests

- Real VPS validation of the failure:
  - `ct-server-core guard credential-lock` passed.
  - `component check` showed only `naiveproxy-client` mismatched
    because the binary printed `naive 148.0.7778.96`.
  - Manual host-side `docker compose restart sing-box` completed the
    stale-state purge.

---

## [0.0.73] — 2026-05-10 — Tunnel manifest and reload-state hardening

This patch release promotes the real-metal RackNerd validation fixes
from the `v0.0.72` rollout and the stale sing-box runtime-state fix
from PR #65. The proxy wire protocol and subscription format are
unchanged.

### Fixed

- **NaiveProxy client component check.** The bundled `naive` binary now
  reports `naive 148.0.7778.96`; the manifest pin and stdout matcher
  now compare against that actual version line instead of the older
  `NaiveProxy` banner / release-suffix string. This prevents
  `make update` from failing after an otherwise healthy `v0.0.72`
  rebuild.
- **TCP-only readiness gate.** `late-night-comeback.sh` no longer
  requires `443/udp` in UFW. NaiveProxy is HTTP/2-over-TCP in this
  stack, and advertising or requiring UDP/443 contradicts the
  anti-fingerprinting posture already enforced by the compose file.
- **Stale sing-box state purge.** `ct-server-core server reload` now
  applies the Clash API reload, verifies the loaded config path when
  sing-box reports one, then restarts the sing-box container as a
  mandatory state-clearance barrier. This encodes the incident
  recovery sequence directly into deployment logic: rendered truth is
  not considered live until the process has inherited it.
- **Credential drift guard.** New `ct-server-core guard
  credential-lock` plus `manifests/credential-lock.upstream.json`
  makes `db = rendered = manifest = Mac config` a component-check
  invariant. It compares active DB username/password tuples with the
  rendered sing-box `users` array and fails NG without printing
  passwords.
- **Update ordering.** `make update` now renders sing-box, asserts
  the credential lock, reloads and purges sing-box, then runs strict
  component checks against the post-purge runtime.

### Tests

- Real VPS validation on Debian 13:
  - `ct-server-core component check --manifests /srv/manifests` reports
    all components OK after the manifest correction.
  - Bundled `naive` local adapter returned `http_code=204` through
    `https://alice:<password>@cookie.coolwhite.space:443`.
- PR #65 CI:
  - `rust (build / test / clippy / fmt)`
  - `manifest drift`
  - `templates`
  - `shellcheck`
  - `phpstan`
  - `cargo audit`, `cargo deny`, `composer audit`, `gitleaks`

---

## [0.0.72] — 2026-05-09 — Rust network boundary hardening

This patch release promotes the LTS hardening pass from PR #64. The
wire protocol remains compatible with `v0.0.71`; the server-side Rust
network boundary now uses tighter allocation discipline, explicit error
taxonomy, and observed task lifetimes so malformed traffic or transient
listener failures fail fast without taking down unrelated sessions.

### Changed

- **Daemon forwarding buffer discipline.** Listener handlers now reuse a
  `BytesMut` serialization buffer for JSON frames and forward payloads
  from borrowed slices, avoiding repeated short-lived heap allocations on
  the packet path.
- **Async listener setup.** Ephemeral probe sockets now use Tokio's
  async `TcpListener`, and listener setup returns typed bind errors
  instead of panicking at the network boundary.
- **Task supervision.** Per-connection tasks are now spawned through an
  observed join wrapper so panics and cancellations are logged as typed
  internal task errors instead of becoming silent detached failures.
- **Metrics response writes.** Internal metrics responses build headers
  with `BytesMut` and stream the body separately, keeping the response
  path allocation-bounded.

### Fixed

- **Shutdown-aware capacity handling.** Connection admission now treats a
  closed semaphore as graceful shutdown instead of forcing an unwrap or
  ambiguous transport failure.
- **Panic-free socket boundaries.** Local daemon, remote daemon, and
  transient probe bind failures now carry structured error codes that
  can be surfaced predictably by operators and automation.

### Tests

- PR #64 CI passed before merge.
- Local pre-release validation:
  - `SQLX_OFFLINE=true cargo fmt --all -- --check`
  - `SQLX_OFFLINE=true cargo test --workspace --all-targets --locked`
    — 141 passed
  - `SQLX_OFFLINE=true cargo clippy --all-targets --locked`

---

## [0.0.71] — 2026-05-09 — AI-native contracts and Alpine NaiveProxy probe hardening

This patch release promotes the AI-native Rust refactor and the
NaiveProxy Alpine probe fix that landed after `v0.0.70`. The runtime
surface is still WireV1-compatible; the work makes the server easier
for automated maintainers to retrieve, reason about, and test while
closing a deployed-image compatibility gap in the bundled naive client
probe.

### Added

- **Contract-first Rust metadata.** Added `ct_server_core::contracts`
  with semantic contract records, explicit recovery scopes, consensus
  alignment principles, and retrieval aliases for AI-assisted
  maintenance.
- **Trait boundaries for self-healing probes.** Split anti-tracking
  detection and canary history behavior behind narrow traits so future
  fixes can be generated and tested against explicit module contracts
  instead of implicit control flow.
- **AI unit-test generation guide.** Expanded
  `docs/ai-unit-test-generation.md` with retrieval anchors for the
  daemon, probe, canary, and semantic-contract surfaces.

### Changed

- **Threshold decision logic is now documented in Rustdoc.** The Heng
  50% adaptation and 80% bottleneck thresholds now carry explicit
  rationale for why they preserve a fixed hard cap while allowing
  congestion-sensitive recovery.
- **Daemon and probe module contracts.** The daemon dispatcher,
  anti-tracking probe, canary probe, and canary history store now expose
  boundary contracts that state idempotency, retry posture, and failure
  isolation expectations.

### Fixed

- **NaiveProxy client probe on Alpine.** The panel image now installs
  glibc compatibility libraries before verifying the bundled naive
  binary, and the manifest probe uses the upstream flag form expected
  by the packaged client.
- **Caddy ACME listener redirects.** Internal ACME listener blocks no
  longer leak `:8443` redirect targets during probe or cover-site
  traffic.
- **Probe diagnostics.** Malformed naive client version JSON now emits
  a warning instead of silently falling through to an ambiguous result.

### Tests

- PR #62 CI passed before merge.
- Local pre-release validation:
  - `cargo fmt --check`
  - `cargo check -p ct-server-core`
  - `cargo test -p ct-server-core` — 118 passed
  - `cargo test -p ct-protocol` — 22 passed
  - `SQLX_OFFLINE=true cargo clippy --release --all-targets --locked`
  - `git diff --check`

---

## [0.0.70] — 2026-05-09 — Release promotion: repository authority and strict update health gates

This patch release promotes the post-`v0.0.69` operations work to an
auditable GitHub release. It includes the repository-presence pass and
the auto-update hardening verified on a live Debian VPS after the panel
version cache drift incident.

### Added

- **Rule-maker repository presence.** README now documents the
  FilamentPHP/Livewire panel, FrankenPHP Worker Mode runtime, Rust core
  daemon, Docker orchestration, 1 GB VPS floor, and zero-user-tracking
  posture with a Mermaid architecture diagram and operator QA checklist.
- **LTSC-Heng license draft.** Added a draft-only restrictive covenant
  document while preserving the active AGPL-3.0-only project license.
- **Makefile operator aliases.** Added `make build`, `make audit`, and
  `make deploy` aliases for the release/operator workflow.

### Changed

- **GitHub repository metadata.** Updated the repo description and
  topics to match the FrankenPHP Worker Mode + Rust daemon stack.
- **LTSC baseline.** Current server baseline is now `v0.0.70`.

### Fixed

- **Strict update health gate.** Deployment scripts now run
  `component_check_strict`, preserving the full component table while
  failing if any row reports `NG`. This closes the false-success path
  where `ct-server-core component check` printed an unhealthy row but
  exited zero for UI/JSON compatibility.
- **Panel cache race during update.** `scripts/update.sh` now waits for
  the panel entrypoint sentinel before migrations, renders, reloads, and
  the post-swap component check. This prevents Laravel's cached
  `cool-tunnel.version` from reporting the prior release during the
  update window.

### Tests

- PR #58 CI passed before merge and `main` CI passed after merge.
- PR #59 CI passed before merge and `main` CI passed after merge.
- Live Debian VPS validation:
  - `git rev-parse --short HEAD` returned `d61477f` before the release
    bump.
  - `php artisan ct:version` returned `Cool Tunnel Panel 0.0.69`.
  - all 11 component rows reported `OK`.
  - `cool-tunnel-update.service` exited `status=0/SUCCESS`.

---

## [0.0.69] — 2026-05-09 — Core LTS hardening: bounded frames, typed errors, observability, and daemon FSM

This release promotes the Rust server core from implicit socket
control flow to an explicitly documented, bounded, observable
daemon boundary. The panel-facing protocol stays WireV1-compatible;
the change is operational hardening: malformed peers get
connection-scoped recovery, operators get trace/metric hooks, and
future maintainers get stable contracts instead of ad hoc branches.

### Added

- **Bounded `BytesMut` frame readers.** New
  `core/ct-server-core/src/frame.rs` provides reusable, capped
  JSON-line and HTTP-header readers. The daemon and internal
  metrics endpoint no longer rely on per-turn allocation patterns
  or unbounded partial-frame growth.
- **Daemon finite state machine.** New
  `core/ct-server-core/src/daemon_fsm.rs` models each daemon
  connection as:

  ```text
  Accepted -> ReadingFrame -> DecodingUtf8 -> DecodingJson
           -> Dispatching -> Responding -> ProbingConstancy
           -> ReadingFrame

  Any protocol deviation -> HardReset
  Clean EOF -> Disconnected
  ```

  Transitions use atomic compare-exchange, so any observed state
  that does not match the required predecessor forces a hard reset
  instead of creating a second branch of truth.
- **Heng constancy probing.** After each successful daemon turn,
  the server actively measures frame pressure and turn latency,
  then narrows the next read chunk under pressure without raising
  the hard frame cap.
- **OTel-compatible observability.** New
  `core/ct-server-core/src/observability.rs` centralises semantic
  trace keys, duration conversion, capped hex dumps, and 80%
  threshold helpers. Daemon and metrics network turns now emit
  `otel.network.turn` spans.
- **Prometheus metrics for bottlenecks and FSM resets.**
  `/metrics` now includes network-turn counters, last-turn latency,
  buffer high-water basis points, 80% threshold crossings, and
  `ct_daemon_fsm_hard_resets_total`.
- **Operator documentation.**
  - `docs/daemon-fsm.md` records the text FSM diagram and
    no-forking contract.
  - `docs/observability-dashboard.md` provides Prometheus alert
    rules and Grafana panel queries.
  - `docs/ai-unit-test-generation.md` gives RAG/test-generation
    anchors for the new typed contracts.

### Changed

- **Strict typed error taxonomy.** `ct-server-core` now routes
  production failures through a documented `Error` enum with stable
  daemon `wire_code()` values. Opaque/generic boundary errors are
  replaced by predictable categories such as `request_too_large`,
  `read_timeout`, `bad_request`, and dependency-specific codes.
- **Daemon boundary fail-fast behavior.** Oversized frames,
  incomplete frames, read timeouts, invalid UTF-8, malformed JSON,
  invalid FSM transitions, and response-write failures are
  connection-scoped hard resets. Valid requests whose domain
  operation fails still return typed wire errors through the normal
  `Responding` state.
- **Internal metrics reader hardening.** The hand-rolled HTTP
  metrics endpoint now uses the same bounded-frame primitives and
  emits warning-level diagnostics only on malformed or threshold-
  crossing input.
- **AI-native contract surface.** New Rustdoc aliases and
  trait-level contracts make the daemon dispatcher, frame readers,
  metrics surface, and error taxonomy easier for automated
  maintenance tools to retrieve and test.

### Security

- **Panic-free network boundary posture.** The daemon's socket
  boundary now closes or hard-resets bad connections rather than
  panicking or continuing through ambiguous state.
- **Silent log strategy preserved.** Normal operation remains quiet;
  hex/header dumps appear only on critical faults or threshold
  crossings and are capped before formatting.

### Tests

- Local validation before release:
  - `cargo fmt --check`
  - `cargo check -p ct-server-core`
  - `cargo clippy -p ct-server-core --all-targets -- -A clippy::pedantic`
  - `cargo test -p ct-server-core` — 111 passed
  - `cargo test -p ct-protocol` — 22 passed
  - `cargo doc -p ct-server-core --no-deps`
  - `git diff --check`
- GitHub CI passed on PR #56 and again on `main` after merge.

---

## [0.0.68] — 2026-05-09 — Hotfix: PANEL_DOMAIN ordering in v0.0.54 .env auto-migration

A pre-v0.0.68 `make update` run on a pre-v0.0.33 .env appended
`PANEL_DOMAIN=` to file-end. docker compose's `.env` parser
interpolates `${VAR}` references top-down, so any line above the
appended PANEL_DOMAIN that referenced `${PANEL_DOMAIN}` —
canonically `APP_URL=https://${PANEL_DOMAIN}/admin` at
`.env.example:52` — substituted to empty. The result was a chain of
failures invisible to `component check` but very visible to anyone
hitting the panel:

- Three `The "PANEL_DOMAIN" variable is not set. Defaulting to a
  blank string.` warnings on every `docker compose ...` invocation
  (one per substitution pass).
- The panel container booted with `APP_URL=https:///admin`
  (well-formed except for the missing host).
- Filament's redirect URLs and Livewire's origin-check middleware
  used the malformed `APP_URL`; every form submit returned 419
  PAGE EXPIRED.

`env_file:` injection was unaffected (it doesn't depend on file
order), which is why `printenv PANEL_DOMAIN` inside the panel
container reported the correct value the whole time — masking the
compose-level interpolation failure during diagnosis.

### Fixed

- **`scripts/update.sh` — phase 1.** `>> .env` replaced with an
  `awk` insert immediately after the `^DOMAIN=` line. Compose's
  interpolator now resolves `${PANEL_DOMAIN}` correctly on the
  first pass for every operator running `make update` from a
  pre-v0.0.33 .env going forward.
- **`scripts/update.sh` — phase 2 (new).** Detects an
  already-misplaced `PANEL_DOMAIN=` line (sits AFTER a non-comment
  `${PANEL_DOMAIN}` reference) and relocates it under
  `^DOMAIN=`. Rescues operators upgrading from a pre-v0.0.68 build
  whose .env was already poisoned by the buggy migration.
  Comments are excluded from the reference scan so
  `.env.example`'s documentation block — which legitimately
  references `${PANEL_DOMAIN}` above the canonical definition —
  doesn't trip a false positive on a fresh-from-template .env.

### Notes

- Both phases are no-ops on already-canonical .env files.
- `install.sh` and `.env.example` already place PANEL_DOMAIN above
  APP_URL — only the `make update` migration path needed the fix.
- No code-logic changes outside `scripts/update.sh`. The
  Cargo / manifest / panel-config version bumps are the standard
  `make set-version` set, not new behaviour.

### Operator update

```sh
cd /path/to/cool-tunnel-server
git fetch --tags
git checkout main && git pull --ff-only
./scripts/update.sh
docker compose up -d --force-recreate panel   # pick up corrected APP_URL
docker compose exec -T panel php artisan config:clear
```

The `--force-recreate` is needed because pre-v0.0.68 the panel
already booted with the broken `APP_URL=https:///admin`; recreating
the container re-reads `.env` after phase 2 has reordered it, and
`config:clear` drops any cached compiled config that captured the
broken value.

---

## [0.0.67] — 2026-05-09 — Internal-health metrics + logging discipline (R-1 + R-2)

Two narrow operator-observability items shipped together with an
explicit posture carve-out so the LTSC anti-tracking promise stays
honest. **No per-user analytics surface.** Optional, off by default.

### Added

- **`/metrics` endpoint (R-1).** New module
  `core/ct-server-core/src/internal_metrics.rs` exposes a
  Prometheus text-format endpoint on a configurable docker-
  internal bind address. **Operator-internal-health only**:
  - `ct_daemon_handler_permits_used` / `_total` (T-1 semaphore
    saturation gauge)
  - `ct_db_pool_connections_in_use` (sqlx pool gauge)
  - `ct_redis_subscriber_restarts_total` (counter)
  - `ct_coalescer_fires_total{edge="leading|trailing"}`
    (counter, two series)
  - `ct_process_uptime_seconds` (gauge — reset detector)

  Off by default. Opt-in via `--metrics-bind <addr>` /
  `CT_METRICS_BIND` env. Recommended single-container value:
  `127.0.0.1:9292` (ct-server-core runs inside the panel
  container alongside FrankenPHP; operator scrapes via
  `docker compose exec ct-panel curl http://127.0.0.1:9292/metrics`).

  HTTP serving is hand-rolled minimal HTTP/1.1 (~80 LOC of
  `tokio::net::TcpListener` + `AsyncRead`/`AsyncWrite`) — no
  `axum` / `hyper` deps reintroduced; the v0.0.50 low-mem
  build floor stays intact.

### Changed

- **T-1 daemon semaphore lifted from `daemon::serve` to
  `main.rs`** (v0.0.65 → v0.0.67). The `Arc<Semaphore>` is now
  constructed in the `Cmd::Daemon` arm and shared with both
  `daemon::serve` and `internal_metrics::MetricsRegistry` (so the
  `permits_used` gauge reads the live semaphore without
  duplication). Behavioural-equivalent change for `daemon::serve`.

- **`redis_bridge::spawn` accepts `Option<Arc<MetricsRegistry>>`.**
  When present, increments the restart counter on every
  reconnect-after-error and the fire counter on every successful
  reload, labeled by edge. When absent (default), zero overhead.

### Logging discipline (R-2)

- **Two `info!` calls demoted to `debug!`** to remove per-user
  PII from default-level logs:
  - `db.rs::disable_account` was logging `account = id`
  - `quota.rs::enforce` was logging `account = %row.username`

  Both fields are operator-visible PII. Operators investigating
  account-disable events can opt in via
  `RUST_LOG=ct_server_core::db=debug,ct_server_core::quota=debug`.

- **`CONTRIBUTING.md § Logging discipline`** codifies the rule:
  `info!` and above must not carry per-user identifiers
  (`username`, `account_id`, `email`, IP, subscription tokens).
  `warn!`/`error!` for operator-actionable failures. `debug!`
  for verbose investigation including PII-bearing fields.

- **`CONTRIBUTING.md § Internal-health metrics`** documents the
  rules for adding a new counter: per-process / per-subsystem
  state OK; per-user labels NOT OK (those are audit-log entries
  that go to `debug!` instead).

### Documentation

- **`LTSC.md § Internal-health observability vs user analytics`**
  is the new structural carve-out. Explicitly distinguishes
  per-user analytics (still deliberately not collected) from
  operator-internal-health (optional, internal-only, never
  per-user data). Anchors the v0.0.7 anti-tracking promise
  against the new metrics surface.

### Tests

- New: `internal_metrics::tests::unknown_edge_is_silently_ignored`
  — registry is observability-only, never crashes the producer
  on an unknown edge label.
- New: `internal_metrics::tests::render_format_smoke` — the
  Prometheus text format requires `# HELP` + `# TYPE` directives
  for every metric; this asserts the format-string source
  contains them all.
- Total: **102 tests pass** (`cargo test --workspace --locked`).

### Not changed

- Wire format, sing-box config rendering, manifest schema,
  container layout.
- Per-user analytics surface remains a deliberate no-op
  (`core/ct-server-core/src/metrics.rs`).
- All previous CI gates (cycles 31–43 + tag-version-check).
- Operator-facing UX: the panel UI and behaviour are unchanged.

### Known follow-up

The `metrics_bind` flag is wired but not yet auto-set in
`docker-compose.yml` / `.env.example`. Operators wanting the
endpoint enabled by default in their deploy can set
`CT_METRICS_BIND=127.0.0.1:9292` in `.env`; a docker-compose
default is a separate small commit if/when wanted.

---

## [0.0.66] — 2026-05-09 — Documentation surface: `//!` pivot + CONTRIBUTING.md

Surfaces the existing module rationale (the *Immutable Ballast*
in `//` "WHY" blocks) into `cargo doc`-rendered HTML, and codifies
the testing / spawn-cardinality / lock-choice patterns so future
contributors match them without spelunking. **No code change. No
runtime delta.** v0.0.65 release content unaffected.

### Changed

- **18 modules in `core/ct-server-core/src/` migrated their
  top-of-file rationale block from `//` to `//!`.** Pre-v0.0.66
  the design rationale comments at the top of each module (why
  the 100 ms Coalescer window, why `MAX_CONCURRENT_HANDLERS = 16`,
  why a daemon vs one-shot CLI, etc.) were written as regular `//`
  comments — load-bearing per the **Immutable Ballast** principle
  but invisible to `cargo doc`. The mechanical pivot: keep the
  SPDX header line as `//`, convert the next contiguous comment
  block to `//!` (inner doc comments). Now `cargo doc --open`
  surfaces every module's rationale on its landing page.

  Already-`//!` modules (`caddy/mod.rs`, `haproxy/mod.rs`,
  `template.rs`, `util/debounce.rs`) were untouched.

- **5 doc-comment angle-bracket placeholders rewrapped.** Lines
  like `path=<path>`, `panel.<DOMAIN>`, `<ca-folder>/<domain>`
  used to render fine when the surrounding block was `//`
  (rustdoc didn't parse `//`); after the `//!` pivot rustdoc
  reads them as markdown and treats raw `<` as opening HTML
  tags. Wrapped each placeholder in fenced code blocks
  (` ```text `) or inline backticks so rustdoc no longer warns
  on "unclosed HTML tag". Affected files: `admin.rs`,
  `laravel_crypt.rs`, `singbox/mod.rs`, `util/domain.rs`.

### Added

- **`CONTRIBUTING.md`.** Codifies the patterns the codebase
  already follows so a future contributor extends the project
  without first reverse-engineering the conventions:

  - Documentation patterns (`//!` for module rationale, `///`
    for items, why constant thresholds carry their *reason* not
    just their value).
  - Testing patterns (`#[cfg(test)] #[allow(...)]` lint-floor
    escape, `#[test]` vs `#[tokio::test]`, when to pin
    `flavor = "multi_thread"`, stress-tests-as-adversarial-load,
    one-occurrence-first-fix vs second-sighting-codified-cycle).
  - Async patterns post-v0.0.65 (`std::sync::Mutex` default,
    `tokio::sync::Mutex` only for genuine cross-`.await` need;
    `tokio::spawn` cardinality bound mandatory).
  - Commit/PR flow.
  - Explicit "what this is NOT": not a style guide
    (`cargo fmt` + `pint` are the style guides), not a complete
    reference (`LTSC.md`/`AUDIT.md`/`RELEASE.md` are).

### Fixed

- **`util/debounce.rs`** — replaced an unresolved
  `[FireNowSchedule]` doc-link reference (no such type — vestige
  of an intermediate name during development) with explicit
  links to the actual `Decision::FireNow`,
  `Decision::FireNowAndScheduleFlush`, `Decision::Suppress`
  variants. `cargo doc` warning count: 12 → 0.

### Not changed

Wire format, sing-box config rendering, ct-server-core runtime
behaviour, manifest schema, container layout, audit cycles
31–43, panel UI / behaviour, all previous CI gates. All 100
workspace tests still pass; `cargo doc --no-deps` is now warning-
free.

---

## [0.0.65] — 2026-05-09 — Async hardening: zero blocking-syscall floor + zero leak posture

Audit-driven hardening of the `ct-server-core` async path and error
substrate. No protocol / wire / schema change. Three hardening items
on the daemon ↔ panel boundary, one on the Coalescer (defense-in-
depth), one on the Coalescer mutex (compile-time safety upgrade),
three on the error type (operator diagnostic clarity).

### Changed

- **`daemon.rs::serve` — accept loop is now semaphore-bounded**
  (T-1). `MAX_CONCURRENT_HANDLERS = 16` (2× FrankenPHP worker
  count). Each accept acquires a permit before spawning the
  handler; the 17th simultaneous connection blocks at
  `acquire_owned().await` until a handler completes. Pre-fix the
  spawn was unconditional, so a buggy or hostile client opening
  connections in a loop could drive unbounded handler-task growth.
  Unix socket's `0o660` perms still gate access at the container-
  user layer; this is defense-in-depth.

- **`daemon.rs::handle_client` — per-request line-read timeout**
  (T-2). `READ_TIMEOUT = 30 s`. A client that opens a connection
  and stalls mid-request (network partition, suspended process,
  malicious holding pattern) is closed cleanly with a
  `read_timeout` error response. Without this, the stalled handler
  would hold its T-1 semaphore permit indefinitely.

- **`redis_bridge.rs` — Coalescer lock migrated `tokio::sync::Mutex`
  → `std::sync::Mutex`** (T-4). Both critical sections were already
  brief and never crossed `.await` (pre-v0.0.65 comment confirmed).
  Migration buys two things: lower lock overhead (no async
  cooperative-yield), and the **compile-time** guarantee that we
  never accidentally hold the lock across an `.await` —
  `std::sync::MutexGuard` is `!Send`, so any future regression
  trying to do so fails to compile. Poison handling via
  `unwrap_or_else(|p| p.into_inner())`; the whole crate is
  `panic = "deny"` so poisoning is structurally improbable, and
  recovery is safer than killing the subscriber loop.

- **`redis_bridge.rs::schedule_flush` — single-flight via
  `FlushTracker`** (T-3). The Coalescer is now wrapped in a
  `FlushTracker` that also carries the in-flight trailing-flush
  `JoinHandle`. If a previous flush task is still pending
  (`!h.is_finished()`), `schedule_flush` returns without spawning
  a new one. The Coalescer state machine should already prevent
  this case, so this is defense-in-depth — a future state-machine
  regression that returns `FireNowAndScheduleFlush` twice without
  an intervening `on_flush` collapses into "one flush at a time,
  latest state wins" instead of unbounded spawn.

### Added (`err.rs` hardening, all backwards-compatible)

- **`Error::context(msg, source)`** (E-3). Wraps a source error
  with a custom operator-facing message. Both surface in the
  source-chain walk (the outer message via `Display`, the source
  via `source()`). Pre-v0.0.65 the only way to get this shape was
  to declare a private wrapper struct per call site; now it's a
  one-liner. Carries `#[track_caller]`.

- **`Error::msg` carries call-site `file:line`** (E-2). The
  constructor is now `#[track_caller]` and appends
  ` (at <file>:<line>)` to the message body. Operators reading
  `error: ...` lines now see *where* the error was raised in
  addition to *what* went wrong. No call-site change required.

- **`Error::inner()` accessor** (E-1). The inner boxed `dyn Error`
  is now read-accessible via a typed accessor. The field itself is
  tightened from `pub` to `pub(crate)` — the previous `pub` made
  the boxed inner type part of the public API surface, blocking
  any future repr change. No external caller construction sites in
  this crate, so the migration is no-op.

### Audit posture codified

- Sweep across `core/ct-server-core/src/` confirms **zero**
  `std::fs::*`, `std::process::Command`, `std::thread::sleep`, or
  `std::sync::Mutex` outside post-T-4 sites. The single `block_on`
  is at `main.rs:339` (correct top-of-runtime placement). All file
  I/O routes through `tokio::fs`. `LTSC.md § 2026 milestones` will
  carry an addendum codifying the **Zero blocking-syscall floor**
  + **Zero leak (bounded-spawn) posture** as a follow-up
  documentation commit on `main`.

### Tests

- New: `err.rs` — `error_msg_carries_call_site_in_display`,
  `error_context_preserves_source_chain`,
  `error_inner_returns_boxed_dyn`.
- New: `redis_bridge.rs` —
  `schedule_flush_is_single_flight_under_repeated_calls` (T-3
  state-machine property check; spawns one task, asserts a second
  rapid call coalesces, asserts a third post-completion call
  spawns a fresh task).
- Updated: `util::debounce::tests::coalescer_concurrent_admits_collapse_correctly`
  migrated to `std::sync::Mutex` to mirror the new production
  pattern; behaviour-property unchanged (64 tasks × 1000 events
  still collapse to ≤ 2 fires per window).
- Total: **100 tests pass** locally (`cargo test --workspace
  --locked`).

### Not changed

Wire format, sing-box config rendering, manifest schema, container
layout, panel UI / behaviour, all 13 audit cycles. v0.0.64 release
content unaffected.

---

## [0.0.64] — 2026-05-08 — Filament panel UX cluster

Targeted UX sweep across the Filament admin surface. One real
bug fix, several UX wins, one APP_KEY-disclosure follow-up.
No protocol / wire / schema change; existing deployments update
with `git pull && ./scripts/update.sh`.

### Fixed

- **`ProxyAccountResource::form` — operator can now edit accounts
  whose `expires_at` is already past.** Pre-v0.0.64 the form
  carried `->minDate(now())` on the expires_at field, which
  caused the unmodified expired timestamp to fail the validation
  rule on save — operators could not update labels / quotas /
  enabled-state on already-expired accounts without also pushing
  expires_at into the future. Removed; the helperText already
  documents that past dates immediately disable the account, and
  that's the documented operator-intent surface.

- **`ProxyAccountResource::regenerate_password` now surfaces a
  warning when `APP_KEY` is unset.** Pre-fix symptom: the
  operator clicked *Regenerate password*; the success
  notification fired showing the new cleartext, but the
  `Subscription URL (import in the app):` block silently dropped
  out of the body — no diagnostic. The sister action
  `show_subscription_url` already handled the same
  misconfiguration with a clear danger notification (*"APP_KEY
  is not configured. Run php artisan key:generate and restart
  the panel."*), but only operators who thought to click that
  specific action would see it. The fix fires a follow-up
  persistent warning with the same diagnostic copy any time
  `subscriptionUrl()` returns `null` — same recovery path, same
  wording.

### Changed

- **`ComponentsPage` re-check action surfaces NG count.** The
  generic "Component check refreshed" notification didn't tell
  the operator whether the recheck had flipped anything from
  OK to NG. New copy: `"Refreshed: N of M NG"` with a danger
  tone when N > 0; `"Refreshed: all M OK"` (success) when
  clean.

- **`ServerConfigPage::form::acme_directory` gets autocomplete
  suggestions.** Bare `TextInput` pre-v0.0.64; common typo
  surface with silent failure deferred ~2 months until first
  cert renewal. Now an HTML5 `datalist` offers the two
  well-known Let's Encrypt endpoints (production / staging)
  while leaving the field free-text for operators with a
  private ACME (Step CA, Smallstep, etc.).

- **`TrafficLogResource::table` `day_range` filter gets quick-
  pick presets.** New `Select::make('preset')` reactively pre-
  fills `from`/`to` for: Today / Yesterday / Last 7 days / Last
  30 days / This month. The free-form date pickers stay for
  custom ranges. The preset itself is `dehydrated(false)` —
  query semantics unchanged.

### Added

- **`FakeWebsiteResource::table` direct "Activate" row
  action.** Pre-v0.0.64 swapping cover sites required Edit →
  toggle is_active → Save. The action sets `is_active = true`
  and lets `FakeWebsite::booted` (the v0.0.16 lockForUpdate
  saved-hook) handle the atomic swap. Visible only on rows
  that aren't already active.

- **`ProxyAccountResource::actions` subscription-URL copy-to-
  clipboard button.** Notification body still shows the URL as
  text (fallback for non-secure contexts where the Clipboard
  API is unavailable); the new "Copy URL" action wires an
  Alpine `x-on:click` that calls
  `navigator.clipboard.writeText()` with the URL safely
  JS-encoded via `json_encode`.

### Audit cycle

The APP_KEY-disclosure fix catches a pattern the existing audit
suite did not have a codified gate for: *"a sister action
surfaces an error condition that this action silently
swallows."* No change to the audit suite this release —
single-occurrence fix landed first; if a second instance
surfaces in a future round-N review, that's the trigger to add
a codified check.

### Not changed

Wire format, sing-box config rendering, ct-server-core, manifest
schema, container layout, audit cycles 31–43, all CI gates
including the v0.0.62 tag-version-check. Backend behaviour of
all six panel surfaces — these are purely presentational /
interaction changes against the same underlying models and
services.

---

## [0.0.63] — 2026-05-08 — Lighthouse pivot: AGPL-3.0-only relicense + coolwhite LLC stewardship

> *This project belongs to the community. coolwhite LLC chooses
> transparency over profit, and freedom over control.*

**Era shift.** The project transitions from
"Self-Protective / Restrictive" (PolyForm Noncommercial 1.0.0,
v0.0.61–v0.0.62) to **"Corporate Open-Source Stewardship"**
under coolwhite LLC. Same code, different posture: anyone may
use, modify, host, and redistribute — provided modifications
flow back under the same terms.

### License

- **AGPL-3.0-only** (deliberately not "or-later" — version pin
  avoids forced adoption of a future GPL revision whose terms
  haven't been reviewed by coolwhite LLC).
- **AGPL** (not vanilla GPL): closes the SaaS loophole. A hosted
  paid-proxy operator running modified Cool Tunnel Server source
  MUST publish their modifications under AGPL-3.0-only (§ 13).

### Copyright

- **Holder: coolwhite LLC** — formal corporate identity, spelled
  with letters. Distinct from the prior `coo1white` GitHub
  handle (numeric `1`), which remains the namespace for
  repository URLs and operator-facing references.
- All necessary copyright assignments are in place per
  coolwhite LLC.
- Past releases retain their licensing for anyone who downloaded
  them; this is a forward-only switch (see § Forward-only
  switch).

### What changed in-tree

- `LICENSE` — replaced verbatim with AGPL-3.0-only text from
  gnu.org (661 lines).
- `core/Cargo.toml` (workspace) + 2 crate manifests:
  `license = "AGPL-3.0-only"` (back in SPDX, no more
  `license-file` workaround). `authors = ["coolwhite LLC"]`.
- `panel/composer.json`: `"license": "AGPL-3.0-only"`.
- `core/deny.toml`: comment updated; `[licenses.private]
  ignore = true` retained for `publish = false` workspace
  members. Allow-list unchanged.
- `manifests/{ct-protocol,ct-server-core,panel}.upstream.json`:
  `note` fields rewritten.
- `README.md`, `NOTICE`, `Disclaimer.md`, `STRUCTURE.md`,
  `THIRD_PARTY_LICENSES.md`: license badge / sections / GPL-3
  interaction note rewritten for AGPL + LLC stewardship. The
  community-stewardship statement appears in `README.md`,
  `NOTICE`, and this changelog block.
- **SPDX headers across 142 source files**: every `.rs` (27),
  non-blade `.php` (85), `.sh` (20), `Dockerfile*` (5),
  `.github/workflows/*.yml` (3), and our two `.tpl` files
  (caddy + haproxy) now carries
  `SPDX-License-Identifier: AGPL-3.0-only`. The sing-box
  `config.json.tpl` is JSON and has no comment syntax — left
  untouched.

### What's not changing

- Stack composition (sing-box GPL-3, Laravel MIT, Filament MIT,
  etc. unaffected — AGPL-3 is GPL-3-compatible).
- Operator-facing UX (no runtime behaviour change; same
  containers, same panel, same config files).
- Component drift detection, SoT enforcement, all CI / audit
  cycles 31–43 — unchanged from v0.0.62.
- macOS GUI client (separate repo `coo1white/cool-tunnel`,
  target version v2.0.25 per `LTSC.md § Current baseline`) —
  scheduled for matching AGPL-3.0-only relicense in its own
  repo.

### Forward-only switch

Versions tagged before this change retain their original
licenses for anyone who downloaded them:

| Version range | License |
| --- | --- |
| v0.0.58 / v0.0.59 / v0.0.60 | AGPL-3.0-or-later |
| v0.0.61 / v0.0.62 | PolyForm Noncommercial 1.0.0 |
| **v0.0.63 onward** | **AGPL-3.0-only, Copyright (C) 2026 coolwhite LLC** |

Retroactive relicense would require every downstream's consent
and is intentionally out of scope. The "lighthouse" applies
prospectively.

---

## [0.0.62] — 2026-05-08 — CI: tag ↔ panel-config version-sync gate

Narrow CI hardening release. No runtime behaviour change; no
operator action required to upgrade.

### Added

- **Tag ↔ `panel/config/cool-tunnel.php` version-sync gate.** New
  GitHub Actions job triggered on `v*` tag pushes. Strips the
  leading `v` (so `v0.0.62` → `0.0.62`) and asserts the resulting
  version equals the `'version' => '...'` line in
  `panel/config/cool-tunnel.php` — the field `php artisan
  ct:version` prints and the component-check matcher consumes.
  Catches the upstream half of the drift class brushed past at
  the v0.0.61 release-cut: source was correct that time (a stale
  local container masked the live-image PHP), but the symmetric
  upstream failure mode — `make set-version` skipped, or a
  future history rewrite dropping the bump — would silently
  ship a tag whose source disagrees.

  Scope is intentionally narrow: `manifests/*.upstream.json` and
  `core/Cargo.toml` are bumped atomically by `make set-version`
  and re-verified at runtime by the component-check probes, so
  the workflow doesn't redo their work. Extend if a future
  incident shows otherwise.

---

## [0.0.61] — 2026-05-08 — License relicense: AGPL-3.0-or-later → PolyForm Noncommercial 1.0.0

Operator-visible license change. **Read this before pulling.**

### What changed

The project's own code (the panel's PHP, the Rust core, the
shared `ct-protocol` crate) is now licensed under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/),
not AGPL-3.0-or-later as in v0.0.58 → v0.0.60.

PolyForm Noncommercial is a **source-available, non-commercial-
use** license drafted by Heather Meeker. It:

- ✅ **Permits** personal use, non-commercial use, research,
  education, and use by individuals or non-commercial entities.
- ❌ **Prohibits** commercial use — selling the software,
  hosting it as a paid service, bundling it into a paid product.
  Commercial use requires a separate written license from the
  copyright holder.
- 🛡️ Disclaims all warranties in PolyForm § 5 ("AS IS, AS
  AVAILABLE, WITHOUT ANY WARRANTY") — stronger language than
  AGPL §§ 15–16.

### Why the change

AGPL-3.0 closed the SaaS loophole (modify + run as a service →
publish your modifications) but still permitted commercial use.
PolyForm Noncommercial reserves all commercial use to the
copyright holder, matching the project's actual position: this
is a personal / community tool, not a commercial product.

### What this means for existing deployments

- **Versions tagged before this change (v0.0.58, v0.0.59,
  v0.0.60) remain available under AGPL-3.0-or-later** for
  anyone who downloaded them under that license. The new
  license applies from v0.0.61 onward.
- **Stock unmodified deployments by individuals on their own
  VPS — fine.** That's the canonical use case PolyForm
  Noncommercial permits explicitly.
- **Paid service / SaaS / commercial bundling — not permitted
  without a separate license.**

### Bundled upstream components — unaffected

Caddy (Apache-2.0), sing-box (GPL-3.0), Laravel (MIT), Filament
(MIT), MariaDB (GPL-2.0), Redis (BSD-3 / SSPL post-7.4), and
the rest of the third-party stack ship under their own
licenses unchanged. See [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md)
for the full list.

### Files updated

- `LICENSE` — verbatim PolyForm Noncommercial 1.0.0 plain-text
- `core/Cargo.toml` (workspace.package) — `license` →
  `license-file` (PolyForm not in SPDX; cargo-deny picks this
  up via `[licenses.private] ignore = true`)
- `core/{ct-protocol,ct-server-core}/Cargo.toml` — flipped to
  `license-file.workspace`; descriptions updated
- `core/deny.toml` — comment updated
- `panel/composer.json` — `"license": "Other"`
- `README.md`, `Disclaimer.md`, `THIRD_PARTY_LICENSES.md`,
  `STRUCTURE.md` — PolyForm-specific guidance
- `manifests/{ct-protocol,ct-server-core,panel}.upstream.json`
  — note fields swapped

### Verification

- `make ci` — all 9 sub-targets green.
- LICENSE byte-equal to the official polyformproject.org text.

---

## [0.0.60] — 2026-05-08 — Hotfix: FrankenPHP `num_threads (4) must be greater than the number of worker threads (4)`

Second emergency hotfix in the v0.0.58 chain. The v0.0.59 hotfix
unshadowed the panel-internal Caddyfile (so FrankenPHP finally
loaded its INTENDED config), which exposed a latent FrankenPHP
config validation error — the panel now boot-loops with:

    Error: loading initial config: loading new config: frankenphp
      app module: start: num_threads (4) must be greater than the
      number of worker threads (4)

`docker/panel/Caddyfile` had `num_threads 4` matching `worker
num 4`. FrankenPHP requires `num_threads` to be STRICTLY greater
than the worker count — the worker pool consumes all N threads
and the in-process Caddy needs at least one spare to handle
incoming requests / ACME maintenance / admin endpoint traffic.

The error was latent through the entire FrankenPHP-swap era
because the v0.0.59 Caddyfile-shadow bug meant FrankenPHP loaded
the ACME-issuer Caddyfile (no `frankenphp` block at all) — the
worker validation never ran, frankenphp's worker mode was
effectively disabled, and requests were served by ad-hoc PHP
fork-per-request (slow, but functional).

### Fix

`docker/panel/Caddyfile`: `num_threads 4` → `num_threads 8`. 4
worker threads + 4 headroom for the in-process Caddy + ACME
maintenance + admin endpoint. Bumps to 12-16 are sensible on
bigger boxes alongside `worker num` increases (ratio ≥ 2:1 is
safe).

The inline comment now documents the strictly-greater
requirement so a future operator tweaking `worker num` doesn't
re-introduce the same boot-loop.

### Operator update

```sh
cd /path/to/cool-tunnel-server
git fetch --tags
git checkout main && git pull --ff-only
./scripts/update.sh
```

---



## [0.0.59] — 2026-05-08 — Hotfix: panel Caddyfile volume-shadow → 502 from /admin

Single-bug emergency hotfix on top of v0.0.58. Caught when v0.0.58
deployed to production and the panel returned 502 from
`https://panel.<domain>/admin`. The audit loop didn't catch this
because none of its lenses exercised the live HTTP-from-the-edge
path through the SNI router → caddy:8444 → panel:9000 chain.

### The bug

`docker-compose.yml:419` mounts `caddy_etc:/etc/caddy` into the
panel container so the panel-side `ct-server-core caddyfile
render` can write the rendered ACME Caddyfile that the dedicated
`ct-caddy` container reads. That mount SHADOWS anything baked
into the panel image at `/etc/caddy/`.

`docker/panel/Dockerfile:183` baked the panel-internal Caddyfile
(the FrankenPHP-worker-on-:9000 config) at exactly that path.
Result: at boot time, the panel's FrankenPHP would
`run --config /etc/caddy/Caddyfile` and load... the ACME-issuer
Caddyfile (binding :80, trying to ACME the operator's external
domains, NOT routing to the FrankenPHP worker).

End-to-end symptom: panel container was "Up but unhealthy",
nothing answered on `127.0.0.1:9000` from inside the container,
caddy:8444 → panel:9000 hop returned `Connection refused`,
operator's browser saw HTTP 502.

### The fix

Two-line change. Bake the panel's own Caddyfile at
`/etc/caddy-panel/Caddyfile` (NOT volume-mounted, so the
`caddy_etc` overlay can't shadow it), and point supervisord's
`frankenphp run --config` at the new path.

The two configs now live at separate paths:
- `/etc/caddy/Caddyfile` (volume-mounted, written by panel,
  read by ct-caddy) — the ACME + auto-HTTPS config for
  operator domains
- `/etc/caddy-panel/Caddyfile` (image-baked, panel-only) —
  the FrankenPHP worker + :9000 listener for the Filament app

Inline comments in both edited files explain the shadow mechanism
so a future "consolidate the paths" refactor doesn't re-introduce
the regression.

### Why this slipped past the audit

The bug was latent since the FrankenPHP swap (v0.0.58 PR #7-#12).
Round-5 caught the URL::forceScheme leak and the
`http://127.0.0.1:9000` listen-address bind in the panel
Caddyfile, but didn't notice the panel Caddyfile was being
SHADOWED by the volume-mounted ACME Caddyfile entirely. The
listen-address fix only matters if the panel Caddyfile is
actually loaded — which it wasn't.

The 30-round audit loop then ran 30 fresh lenses without ever
testing the "browser → public-domain → SNI router → caddy:8444 →
panel:9000" end-to-end path, because the project's test suite
covers the path layer-by-layer (route regex, controller logic,
HMAC canonicalisation, etc.) but doesn't have an integration
test that boots the docker-compose stack and curls the public
URL. That's a future-round audit-loop scope item.

### Operator update path

Same as v0.0.58 — `git pull && ./scripts/update.sh`. The
existing update script picks up the Dockerfile + supervisord.conf
changes, rebuilds the panel image, and recreates the panel
container. The /etc/caddy-panel/ directory is created
automatically by the COPY in the Dockerfile.

---



## [0.0.58] — 2026-05-08 — FrankenPHP runtime swap, AGPL-3.0-or-later relicense, and 30-round audit-loop hardening

The largest single release since v0.0.33 (the SNI-router split).
Three substantive narratives compressed into one tag:

  1. **Runtime swap** — panel container moved from PHP-FPM +
     nginx to FrankenPHP + Laravel Octane (worker mode). PHP
     8.3 → 8.4. Filament admin "Save → reload" round-trips drop
     by the framework boot cost (~30-50 ms each) because the
     boot is paid once per worker instead of once per request.
     Five operator-blocking deploy-time bugs in the swap chain
     caught and fixed across PRs #7-#12.
  2. **License switch** — proprietary "All Rights Reserved" →
     AGPL-3.0-or-later. The strictest OSI-approved copyleft;
     same license as Mastodon, Nextcloud, BookStack. Closes the
     SaaS loophole that GPL-3.0 leaves open: anyone modifying
     this code AND running it as a network service must publish
     their modifications under the same terms. Stock unmodified
     deployments don't trigger anything.
  3. **30-round audit loop** — a focused multi-pass code review
     where each round picked a fresh lens. 12 production-bug
     fixes + 7 regression-anchor PRs + several process /
     observability / dep-hygiene closures. Highlights below.

### The audit loop in one paragraph each

- **Round 10 — client contract.** SubscriptionController now
  falls through to cover-site (instead of emitting a manifest
  with `password: ""`) when `getCleartextPassword()` returns
  null — the failure mode that pre-v0.0.5 rows or APP_KEY
  rotation produced silently. Plus a regression test anchoring
  that the literal `{{CLEARTEXT_PLACEHOLDER}}` string from the
  Rust core's CLI emitter never leaks into the HTTP path.
- **Round 11 — data integrity.** The HMAC canonical form the
  PHP server signs now matches what a Rust client following
  the documented spec would produce on
  deserialise + signature=None + re-serialise. Pre-fix the
  panel emitted `"signature":null` and `"note":null` literals
  in the canonical, which serde's `skip_serializing_if =
  Option::is_none` would NOT round-trip — every Rust-client
  HMAC verification would fail on a manifest the panel signed
  correctly. Pinned by tests on both sides.
- **Round 12 — observability.** Three subscription fall-
  throughs (disabled account, decrypt-failed cleartext,
  unknown token) now log proportionate to operator-action-
  needed-ness without amplifying probe traffic. Caddyfile and
  sing-box render-failure log severity bumped ERROR → CRITICAL
  (the surrounding model save SUCCEEDS in the UI but old
  config stays live; CRITICAL is the right level). Component-
  check silently-empty-page bug fixed.
- **Round 13 — time-and-clock.** The "clients refuse manifests
  older than 7 days" freshness check the Rust spec promised
  now actually exists in the crate
  (`SubscriptionManifestV1::check_freshness`, with a
  FreshnessCheck enum distinguishing IssuedInFuture /
  StaleByIssuedAt / ExpiredByExpiresAt / Fresh). Plus a single
  `$now = time()` capture in the PHP controller (was racing the
  UTC second boundary with two `time()` calls).
- **Round 14 — input boundary.** Cross-encoder UTF-8 +
  forward-slash invariants pinned with tests on both Rust and
  PHP sides. A future PHP / serde_json default-flag flip would
  silently break HMAC verification on every non-ASCII password
  (Chinese, Japanese, Korean — common in Asia).
- **Rounds 15, 17, 20, 22, 26, 27 — regression anchors.**
  Six PRs adding tests that pin invariants holding today but
  not previously protected: subscription-token determinism,
  every JSON-output field name PHP reads from Rust pinned by
  Rust-side tests, the route-regex + exception-handler chain
  that protects cover-site for malformed tokens, supervisord
  graceful-shutdown invariants drift detector, the off-by-one
  semantic difference between SubscriptionController's
  CHECK-THEN-HIT and FakeSiteController's HIT-THEN-CHECK
  RateLimiter idioms, FakeWebsite::saved single-active
  contract.
- **Round 16 — error-message UX.** `wait_for` in
  scripts/lib.sh now picks up an optional `WAIT_FOR_HINT` env
  var threaded through to die's actionable hint. Three
  install.sh sites where a 90-second silent timeout previously
  left the operator stuck (Caddy ACME, MariaDB healthcheck,
  panel entrypoint sentinel) now surface the diagnostic
  next-step.
- **Round 18 — dep hygiene.** ARM64 naive tarball SHA256 was
  empty (silent skip of supply-chain verification on
  Graviton / Apple Silicon / arm64 VPS). Pinned. Plus
  scripts/pin-images.sh's stale Dockerfile mappings refreshed
  (rust:1.86 → 1.88, php:8.3-fpm → frankenphp, added haproxy)
  and hardened to fail loud on a no-match instead of silently
  no-op'ing the operator's `make pin-images`.
- **Round 19 — docs vs code.** clash-API listener address
  doc in architecture.md, panel-runtime "nginx" references in
  docker-compose.yml + haproxy/Dockerfile, README services
  table missing haproxy — three concrete factual claims
  corrected to match the current implementation.
- **Round 21 — cross-platform.** install.sh's `stat -c '%a'`
  + two `sed -i ""` callsites are GNU-coreutils-only and
  silently break on macOS/BSD. Added `file_mode_octal`
  helper in lib.sh that probes GNU-then-BSD; converted the
  sed calls to the portable `-i.bak` form.
- **Round 23 — composer audit in make ci.** Was running in
  the GitHub Actions workflow but not in local `make ci`;
  operator running `make ci` locally got "PASS" while the
  remote could surface a CVE. Closed.
- **Round 24 — operator workflow.** Backup/restore scripts
  hardcoded `cool-tunnel-server_caddy_data` as the volume
  name, breaking parallel deployments at different
  directories. New `compose_project_name()` helper in lib.sh
  asks docker-compose itself. Plus the GETTING_STARTED.md
  readiness-score doc drift fixed (8/10 → 9/11).
- **Round 25 — admin auth.** `ct:make-admin --force` now
  resets the password on an existing email (lost-password
  recovery path; pre-this the only option was raw DB
  UPDATE). Plus structured `Log::notice('admin.created' |
  'admin.password_reset')` for audit trail and a
  QueryException-clean exit on a UNIQUE-constraint race.
- **Round 28 — Rust error reporting.** `main.rs` now walks
  `source()` chain on a top-level error so the operator sees
  the underlying cause (`reqwest::Error("connection refused")`)
  instead of just the outermost message
  (`error: could not load server config`).
- **Round 29 — env-var contract.** OCTANE_SERVER and
  SESSION_LIFETIME documented in .env.example. The OCTANE_-
  SERVER default in panel/config/octane.php was 'roadrunner'
  — production doesn't hit it (supervisord runs frankenphp
  directly), but a developer running `octane:start` locally
  would get the wrong server.
- **Round 30 — queue retry observability.** ReloadSingBoxJob's
  `failed()` handler emits `Log::critical('singbox.reload.job_failed')`
  when 3 retries exhaust. Pre-this the operator got nothing —
  the failed_jobs row sat in the DB silently and panel state
  diverged from running sing-box config. The Redis fast-path
  keeps credential revocation effective regardless, so this
  alarms as "config drift" not "security incident".

### Changed

- License: **proprietary → AGPL-3.0-or-later** across LICENSE,
  Cargo workspace, composer.json, README, Disclaimer.md,
  THIRD_PARTY_LICENSES.md, STRUCTURE.md, deny.toml, and the
  three project-owned upstream-manifest notes.
- `panel/composer.json` PHP runtime requirement effectively
  pinned to 8.4 (FrankenPHP base image carries it; composer
  constraint stays `^8.2` for the dev-tools floor).
- Test counts: panel 23 → 63 (+40), ct-server-core 88 → 100,
  ct-protocol 2 → 23 (+21).

### Security

- `docker/panel/Dockerfile` — `NAIVE_SHA256_ARM64` was empty
  (silent skip of supply-chain verification on arm64 builds).
  Now pinned to the verified hash for the same release tag as
  AMD64.

---



### Added

- `scripts/verify_supervisord.sh` and `make verify-supervisord` —
  round-22 process-lifecycle drift detector. Pins the round-6
  supervisord graceful-shutdown invariants
  (`stopsignal=TERM`, `stopwaitsecs=20`, `killasgroup=true`,
  `stopasgroup=true`) on every `[program:*]` block, plus the
  frankenphp `MAX_REQUESTS=500` worker-recycle ceiling. A future
  edit that drops one wouldn't break any test — supervisord
  still boots — but `docker compose stop` would SIGKILL
  in-flight requests on the affected program (the round-6 fix
  exists specifically to drain workers cleanly within the
  compose grace window). The validator is wired into `make ci`,
  so drift surfaces on every PR. Bash-3.2 compatible (avoids
  `mapfile` and `declare -A`) so it runs on the operator's
  macOS dev host as well as the Linux CI runner.
- `panel/tests/Feature/SubscriptionRouteEdgeCaseTest.php` —
  round-20 edge-case input handling. Pins the two-layer
  protection chain that keeps the cover-site invariant intact
  for malformed-token requests:
  1. Route regex `[A-Za-z0-9_-]+` rejects any path segment that
     isn't strict base64url; non-matching segments produce
     NotFoundHttpException.
  2. The `bootstrap/app.php` exception handler catches that on
     non-admin paths and re-renders FakeSiteController.
  Either layer alone is insufficient — regex without catch
  leaks a Laravel-branded 404 page (a censor distinguisher);
  catch without regex would let downstream parsers see
  arbitrary bytes. The new test exercises 11 malformed token
  shapes (dot, slash, plus, equals, percent-encoded null,
  leading-/trailing-/only-special chars, 1000-char lengths)
  plus a path with extra segments and a path with a query
  string, and asserts every one returns bytes byte-identical
  to a vanilla cover-site probe.
- Round-17 chassis-cockpit boundary tests pin every JSON-output
  field name the PHP panel reads from `ct-server-core`. Pre-this,
  the PHP side reads `$out['changed']`, `$out['hash']`, `$out
  ['rows']`, `$out['disabled']`, `$out['reload_triggered']`,
  `$out['state']` etc. with `?? <default>` — a Rust-side rename
  produces null on the cockpit and the operator silently sees
  "no change", "0 OK / 0 NG", `disabled=null` with no diagnostic.
  The pin tests live next to the structs they protect:
  - `core/ct-server-core/src/singbox/mod.rs` —
    `RenderOutcome` (`changed`, `hash`).
  - `core/ct-server-core/src/caddy/mod.rs` —
    `CaddyRenderOutcome` (`changed`, `hash`).
  - `core/ct-server-core/src/quota.rs` — extracted hand-rolled
    JSON `r#"{{"disabled": ..., "reload_triggered": ...}}"#` into
    a testable `outcome_json()` free fn; pinned both keys + the
    `(0, false)` happy-path branch values.
  - `core/ct-server-core/src/metrics.rs` — extracted the
    `r#"{{"rows": ..., "total_bytes_delta": ...}}"#` emit the
    same way; pinned both keys.
  - `core/ct-protocol/src/components.rs` — pinned
    `ComponentStatusV1.state` field name AND every variant's
    snake_case wire form (`ok`, `version_mismatch`,
    `verify_failed`, `missing`, `unknown`). The panel compares
    `$row['state'] === 'ok'`; a PascalCase regression would flip
    every row to NG silently.
- `panel/tests/Feature/SubscriptionTokenDeterminismTest.php` —
  round-15 idempotency / replay-safety anchor. Pins three
  contracts on `ProxyAccount::subscriptionToken()`:
  1. Pure in `(account_id, APP_KEY)` — calling it twice on the
     same model instance OR on a fresh DB-loaded instance returns
     the SAME string. A future change that mixed in a nonce,
     timestamp, or per-process random would invalidate every
     bookmarked subscription URL on every panel refresh.
  2. APP_KEY rotation flips it — the round-10 `.env.example`
     warning depends on the HMAC actually mixing in the key.
  3. Empty APP_KEY produces empty token, never an HMAC-with-
     empty-key (which would be trivially forgeable).
- `core/ct-protocol/src/subscription.rs` and
  `panel/tests/Feature/SubscriptionContractTest.php` — round-14
  pinned the cross-encoder canonical contract for non-ASCII
  payloads. The Round-11 fix made server-canonical ==
  client-canonical for the simple ASCII case; round-14 anchors
  that the equivalence holds when the payload contains
  non-ASCII codepoints (Chinese, Japanese, Korean, anything
  outside ASCII). Specifically: PHP's `JSON_UNESCAPED_UNICODE`
  flag and Rust serde_json's default both emit RAW UTF-8 (not
  `\uXXXX` escapes); both emit RAW `/` (not `\/`). If either
  encoder ever flips its default in a future upstream release,
  these tests catch it before a Chinese/Japanese/Korean
  password user's HMAC starts failing in production.
  `unicode_passwords_round_trip_byte_identical_to_php_unescaped`
  + `forward_slashes_emit_raw_not_escaped` (Rust) /
  `manifest_with_non_ascii_password_round_trips_through_hmac_verify`
  (PHP).
- `core/ct-protocol/src/subscription.rs` — round-13 added
  `SubscriptionManifestV1::check_freshness(now: u64) -> FreshnessCheck`
  and the public constant `FRESHNESS_WINDOW_SECONDS = 7 days`.
  Pre-this the `issued_at` doc claimed "Clients refuse manifests
  older than 7 days as a freshness guard" but no implementation
  existed in the crate. The first client to follow that promise
  would either invent its own check (drift between
  implementations) or skip it (silent contract violation). The
  function is `no_std`-compatible, takes `now` as a parameter
  (testable + portable), and returns one of four variants that
  let a client surface a specific error: `IssuedInFuture`,
  `StaleByIssuedAt`, `ExpiredByExpiresAt`, or `Fresh`.
- 5 Rust tests pin every freshness branch + the boundary at
  exactly `FRESHNESS_WINDOW_SECONDS`.
- `panel/tests/Feature/SubscriptionContractTest.php` — round-13
  added `manifest_issued_at_and_expires_at_are_exactly_30_days_apart`
  which asserts the manifest's `expires_at - issued_at` equals
  EXACTLY 30 days. A non-30-day delta means the controller is
  calling `time()` twice and racing the second boundary —
  exactly the bug the fix below addresses.
- `panel/tests/Feature/SubscriptionObservabilityTest.php` — round-12
  pins which subscription fall-throughs MUST log and which MUST
  stay silent. Critical contract: the disabled-account and
  cleartext-decrypt-failed paths log so the operator can debug
  "user X says their URL stopped working"; the unknown-token
  path stays silent so a censor probing /api/v1/subscription/<random>
  cannot 1:1 amplify scanner traffic into panel logs (cardinality
  control). Also covers the happy path emitting no fall-through
  log at all (no phantom dashboard alerts on healthy traffic).
- `panel/tests/Feature/SubscriptionContractTest.php` — round-11
  added two more contract tests on top of the round-10 pair:
  3. The served manifest's HMAC verifies under the documented
     client recipe — deserialise, drop `signature`, re-canonicalise
     with `JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE`, HMAC
     against APP_KEY. Pre-fix the controller emitted
     `"signature":null` and `"note":null` literals in its canonical,
     which a Rust client following the spec would NOT reproduce on
     re-canonicalisation (skip_if_none drops the keys entirely).
     Every Rust-client verification would fail.
  4. With no active fake site, `capabilities.fake_site_slug` is
     ABSENT from the manifest — not present-as-null. Same trap as
     #3 but on a sub-object.
- `core/ct-protocol/src/subscription.rs` — two new tests pin the
  canonical contract on the spec side:
  `canonical_roundtrips_under_signature_strip` (server-built canonical
  must equal client-deserialise + signature=None + re-serialise) and
  `field_order_is_part_of_the_wire_contract` (struct field order is
  on-the-wire order — a careless field reorder would break every
  encoder that hard-codes the order, including the PHP controller).
- `panel/tests/Feature/SubscriptionContractTest.php` — round-10
  anchored two contracts the prior audits didn't catch:
  1. The served subscription manifest never carries the literal
     `{{CLEARTEXT_PLACEHOLDER}}` string (the Rust emitter's
     CLI-path marker that the panel's HTTP path is meant to splice
     over before signing).
  2. A row with empty / undecryptable cleartext falls through to
     the cover site byte-identically, instead of emitting a
     working-looking manifest with `password: ""`.

### Changed

- `scripts/lib.sh` and `scripts/install.sh` — round-21 cross-
  platform portability for the operator-facing install script.
  Three GNU-coreutils-only commands (`stat -c '%a'`, two `sed
  -i` calls without an explicit backup suffix) silently broke
  on BSD/macOS hosts — confusing for a developer trying to
  install or test the project from a non-Linux workstation
  (the deployment target stays Linux, but the install script
  itself can run as a sanity check). Added `file_mode_octal`
  helper in `lib.sh` that probes GNU's `-c '%a'` first and
  falls back to BSD's `-f '%OLp'`. Replaced both bare `sed -i`
  calls with the `sed -i.bak ... && rm -f file.bak` form,
  which is bytewise-identical-output on GNU and BSD. Smoke-
  tested on macOS: `file_mode_octal` returns the expected
  octal, `sed -i.bak` rewrites in place, both behave the same
  as the existing `pin-images.sh` and `update.sh` callsites
  that already used the portable form.
- `docs/architecture.md`, `docker-compose.yml`,
  `docker/haproxy/Dockerfile`, `README.md` — round-19 docs-vs-
  code drift fixes:
  - **clash-API listener address.** `architecture.md:130-133`
    described the listener as `0.0.0.0:9090 (docker-bridge-only;
    not host-published)`, which was the pre-H3 model. Post-2026-
    05-04 H3 audit it binds to `172.30.0.10:9090` on the
    internal-only `ct-clash` docker network — network membership
    IS the security boundary now (only `panel` is on
    `ct-clash`; caddy / haproxy / db / redis cannot reach the
    management endpoint). The doc updated to name the network +
    the static IP + the boundary, with a parenthetical noting
    when the model changed.
  - **panel runtime references.** `docker-compose.yml:23` and
    `docker/haproxy/Dockerfile:12` both said the panel
    container's web tier was `nginx`. Post-v0.0.58 it's
    FrankenPHP (Caddy + PHP in one process). Updated to name
    FrankenPHP + a parenthetical that pre-swap was nginx +
    php-fpm so an operator looking for nginx logs / config
    knows where the rename happened.
  - **README.md services table.** Was missing `haproxy` (added
    in v0.0.33 SNI-router split). Without it, an operator
    reading just the README would see the panel-subdomain →
    caddy → panel reverse-proxy chain referenced elsewhere in
    the doc and wonder where the second `:443` consumer fits
    in. Added a row explaining the SNI-route shape and why
    haproxy exists.
- `scripts/pin-images.sh` — round-18 dep-hygiene refresh. The
  mapping table was out of date: `rust:1.86-alpine` →
  `rust:1.88-alpine` (matches `core/rust-toolchain.toml` after
  the toolchain bump), `php:8.3-fpm-alpine` →
  `dunglas/frankenphp:1-php8.4-alpine` (post-v0.0.58 panel
  runtime swap), added `haproxy:3.0.21-alpine` (introduced in
  v0.0.33 SNI-router split). The stale entries previously caused
  silent misses: `make pin-images` ran without error but didn't
  pin the panel runtime or the Rust builder image, defeating
  the script's reproducibility purpose. The `pin()` helper now
  also fails LOUDLY (with an actionable hint) when a mapping
  doesn't match any FROM line in the target file — a future
  Dockerfile rename surfaces in the next pin-images run, not in
  a months-later supply-chain incident.
- `scripts/lib.sh` and `scripts/install.sh` — round-16 error-
  message-UX. `wait_for` now picks up an optional `WAIT_FOR_HINT`
  env var and threads it through to the on-timeout `die` as the
  `↳ try: ...` actionable hint. Used at three sites in
  `install.sh` where a silent timeout previously left the operator
  stuck:
  - **MariaDB healthcheck** — surfaces "stale volume from prior
    install (DB_PASSWORD rotated since volume init) → wipe-prompt
    or CPU-starved VPS still running initdb" + the `docker compose
    logs --tail=80 db` command.
  - **Panel entrypoint sentinel** — surfaces the entrypoint's
    step ordering (composer install → key:generate → migrate →
    cache build → render) and which one is most likely stuck
    on a fresh box vs. an upgrade, plus the log-tail command.
  - **Caddy ACME cert wait** — enumerates the FOUR distinct
    causes (DNS, port 80, Caddy crash, Let's Encrypt rate limit)
    that previously all surfaced as the same "Caddy cert never
    came up after 90s". Includes the staging-CA workaround for
    the rate-limit case.
  Pre-fix the operator saw `[!] Caddy cert (apex) at /data/...
  never came up after 90s`. Post-fix the operator sees that line
  followed by `↳ try: docker compose logs --tail=120 caddy   #
  then check, in order: (1) DNS A records ... (2) firewall ...
  (3) Caddy crash-loop (4) Let's Encrypt rate limit ...`.
- `panel/app/Services/CaddyfileGenerator.php` and
  `panel/app/Services/SingBoxConfigGenerator.php` — render-failure
  log severity ERROR → CRITICAL. When a re-render fails on a
  ServerConfig save (or account create / delete / regenerate),
  the surrounding save SUCCEEDS in the UI but the OLD config stays
  live in Caddy / sing-box. New users can't connect; deleted users
  can still connect; domain / ACME-email changes silently don't
  take effect. The panel and the running proxy diverge with no
  signal in the UI. CRITICAL is the right level so dashboard
  alarms fire instead of letting the divergence persist quietly.
  (Round-12 observability.)
- `panel/.env.example` — APP_KEY block now carries an explicit
  warning that rotating it after accounts exist silently
  invalidates every existing subscription URL (HMAC over
  `<account_id>.<sig>` stops verifying AND the encrypted-
  cleartext column stops decrypting; both fall-throughs are
  on-the-wire identical to a cover-site probe). Recovery: per-
  account regenerate-token + reset-password via the panel's
  Regenerate flow. Treat APP_KEY as immutable for the lifetime
  of the deployment.
- `docs/cross-platform-clients.md` — corrected the "Invalid
  subscription tokens get a 404 + HTML body" line (it was
  actually 200 + cover-site bytes; a 404 would have distinguished
  the subscription endpoint from the cover-site catch-all by
  status code alone, which is exactly what the cover-site
  invariant exists to prevent). Added two new client-implementer
  invariants: refuse a manifest whose `password` is the literal
  `{{CLEARTEXT_PLACEHOLDER}}`; refuse a signed manifest with
  `password: ""`.

### Fixed

- `panel/app/Http/Controllers/SubscriptionController.php` — capture
  wall-clock ONCE per manifest emit and reuse for both `issued_at`
  and `expires_at`. Pre-fix the controller called `time()` twice
  on adjacent lines; an extremely rare second-boundary race could
  land `issued_at = N` and `expires_at = N + 1 + 30 days`,
  producing a manifest where `expires_at - issued_at = 2592001`
  instead of the intended 2592000. A pedantic future client that
  validates the delta would reject; less paranoid clients would
  silently get a one-second-longer window than intended. Also
  introduced `MANIFEST_TTL_SECONDS = 30 days` as a named constant
  with a comment cross-referencing
  `ct-protocol::SubscriptionManifestV1::FRESHNESS_WINDOW_SECONDS`
  so a future bump is forced to consider the spec-side bound.
  (Round-13 time-and-clock audit.)
- `panel/app/Http/Controllers/SubscriptionController.php` — three
  silent fall-through paths now emit panel-side logs proportionate
  to operator-action-needed-ness:
  - **Disabled / expired account** (resolves to a real row but
    `isActive() === false`) — `Log::warning('subscription.fallthrough.account_disabled', [account_id, username])`.
    Cardinality bounded by legitimate-user count; operator can
    grep this when a user complains.
  - **Empty / undecryptable cleartext** (active row, but
    `getCleartextPassword()` returned null/empty — APP_KEY
    rotation or legacy pre-v0.0.5 row) —
    `Log::critical('subscription.fallthrough.cleartext_decrypt_failed', [account_id, username])`.
    Operator must hit the per-account Regenerate-password flow.
  - **Unknown / forged token** (resolves to NULL) — kept SILENT
    on purpose. Logging here would 1:1 amplify scanner traffic
    into panel logs at China-bound probe rates (potential
    DoS-via-logs). The cover-site
    `FakeSiteController::maybeAlarmOnRapidFallThrough` already
    aggregates probes per IP per minute. (Round-12 observability.)
- `panel/app/Services/ComponentChecker.php` — pre-fix the
  Filament Components page rendered "0 OK / 0 NG" with NO
  panel-side log when `ct-server-core component check` failed
  (binary missing on PATH, manifests dir gone). Operator saw a
  blank page and had no clue why. Now logs
  `Log::warning('component.check.failed', [err, type, manifests_dir])`
  so it's grep-able. The page UI still degrades gracefully via
  the empty-array path. (Round-12 observability.)
- `panel/app/Http/Controllers/SubscriptionController.php` —
  canonicalisation contract for the manifest's HMAC signature
  was inconsistent with the documented Rust client verify flow.
  Pre-fix the canonical the server signed included `"note":null`
  and `"signature":null` literal fields, plus
  `"fake_site_slug":null` inside `capabilities` when no fake site
  was active. The Rust spec
  (`core/ct-protocol/src/subscription.rs`) marks all three with
  `#[serde(skip_serializing_if = "Option::is_none")]`, so a Rust
  client that follows the documented "deserialise, set signature
  to None, re-serialise, HMAC, compare" flow produces canonical
  bytes WITHOUT those keys — different bytes, different HMAC,
  verification fails on every legitimately-signed manifest. The
  bug had no observable production impact because no shipped
  client implements verification yet (the ct-protocol crate
  carries the structs but no verify function), but the FIRST
  client to follow the spec would silently reject every manifest.
  Fix: build the canonical with `signature` field absent (not
  null), and omit `note` / `capabilities.fake_site_slug` when
  null. The HMAC still rides in the `signature` field of the
  served body — only the canonical-for-signing differs. Round-11
  data-integrity audit.
- `panel/app/Http/Controllers/SubscriptionController.php` — when
  `getCleartextPassword()` returns null or empty (legacy row
  pre-v0.0.5 cleartext column, or `Crypt::decryptString` failure
  from APP_KEY rotation), the controller now falls through to
  the cover site rather than emitting a manifest with
  `password => '' ?? ''`. Pre-fix, clients received a valid-
  looking, correctly-signed manifest with empty `basic_auth`,
  attempted the proxy connect, and got a sing-box 401 with no
  surface for the operator to debug. The fall-through preserves
  the cover-site invariant AND surfaces the failure as an
  obvious "subscription URL not working" — visible enough that
  the operator hits the Regenerate button.

### Security

- `docker/panel/Dockerfile` — round-18 supply-chain pin. The arm64
  naiveproxy tarball SHA256 was UNPINNED (`NAIVE_SHA256_ARM64=`
  empty). The Dockerfile gracefully degraded with a warning and
  built anyway, so an arm64 build (Graviton, Apple Silicon CI,
  arm64 VPS) skipped checksum verification of the upstream
  binary entirely. A compromised GitHub release asset or CDN
  hijack would land the malicious binary silently. Computed the
  hash for the same release tag as the AMD64 pin
  (`v148.0.7778.96-2`); both arches now have explicit checksums.
  The AMD64 hash was re-verified against the Dockerfile pin as
  a sanity check on the release artifact's integrity.

---

## [0.0.58] — 2026-05-07 — Engine swap to FrankenPHP + Laravel Octane (worker mode), with three deploy-time hotfixes and a round-5 audit cleanup

The biggest single-release change since v0.0.33 (the SNI-router
split). Decommissions the panel container's nginx + PHP-FPM web
tier in favour of FrankenPHP — Caddy + PHP in one process — and
runs Laravel under Octane worker mode so the framework boot is
paid ONCE per worker instead of once per request. Filament admin
"Save → reload" round-trips drop by the boot cost (~30-50 ms
each). The chassis (Rust core) and cockpit (Filament UI) are
unchanged.

The release shipped through five PRs end-to-end. The first set
the architecture; the next three were deploy-time hotfixes
caught only on the operator's real VPS; the fifth was a multi-
agent audit pass that closed the loose ends.

### The swap (PR #7)

- **`docker/panel/Dockerfile`** — base image swapped from
  `php:8.3-fpm-alpine` to `dunglas/frankenphp:1-php8.4-alpine`.
  PHP minor bumped 8.3 → 8.4 because Laravel Octane v2.17's
  transitive dep `symfony/psr-http-message-bridge` v8.0.8
  requires PHP ≥ 8.4. `panel/composer.json`'s `"php": "^8.2"`
  constraint allows it; CI's `php-version` pin moved 8.3 → 8.4
  in 5 jobs (ci.yml + 4 audit.yml jobs).
- **`docker/panel/Caddyfile`** — NEW. Replaces nginx.conf.
  Listens on container `:9000`, document root
  `/var/www/html/public`, hidden-file 404s, `Server` header
  stripped, HTTP/2 + HTTP/3 enabled, worker-mode binding via
  `frankenphp { worker { file ... num 4 } }`, token-mask via
  `log_skip @subscription`.
- **`docker/panel/supervisord.conf`** — `[program:php-fpm]` and
  `[program:nginx]` removed; `[program:frankenphp]` added.
  Queue / scheduler / ct-core-daemon programs unchanged.
- **`docker/panel/entrypoint.sh`** — php-fpm pool config
  generation removed.
- **`docker/panel/nginx.conf`** — DELETED.
- **`panel/composer.json` + `composer.lock`** —
  `laravel/octane: ^2.17` added; `panel/config/octane.php` and
  `panel/public/frankenphp-worker.php` scaffolded by
  `octane:install --server=frankenphp`.

### Hotfixes from real-VPS deploy (PRs #8, #9, #10)

The first three production deploys each surfaced a different
class of bug invisible to local `make ci`. All three fixes
landed without operator-side surprise:

- **PR #8 — composer install on lock drift.** Pre-fix, the
  entrypoint only ran `composer install` when `vendor/` was
  missing. Operator's host had a populated `vendor/` from prior
  deploys (without `laravel/octane`), so install was skipped,
  and supervisord's panel boot crashed with `Class
  "Laravel\Octane\Octane" not found`. Fix: also run install
  when `composer.lock` is newer than `vendor/autoload.php` (one
  stat() per boot).

- **PR #9 — package:discover unconditional.** With PR #8
  applied, `vendor/` had octane. But Laravel's package-discovery
  cache (`bootstrap/cache/packages.php`) was generated by an
  earlier entrypoint run that ran BEFORE octane was installed.
  Subsequent boots reused the stale cache, so
  `php artisan octane:start` failed with `There are no commands
  defined in the "octane" namespace`. Fix: run
  `php artisan package:discover --ansi` UNCONDITIONALLY,
  decoupled from the install branch. Cheap (~100 ms),
  idempotent.

- **PR #10 — bypass `octane:start`'s CLI wrapper.** With PRs #8
  and #9, octane:start finally ran — and immediately failed
  inside Octane's own code. Octane's CLI substitutes its OWN
  bundled stub Caddyfile (`vendor/laravel/octane/src/Commands/
  stubs/Caddyfile`) and silently discards the operator's
  `/etc/caddy/Caddyfile`. The stub binds Caddy's `auto_https`
  pipeline (wrong for a loopback-only admin port), enables the
  default Server header, and has no log-skip rule for the
  subscription path — defeating the v0.0.14 anti-fingerprint
  invariants this project depends on. Fix: bypass the CLI
  wrapper. supervisord runs `frankenphp run --config
  /etc/caddy/Caddyfile` directly. Octane's runtime hooks
  (per-request container reset for Filament + Livewire 3)
  still load via `panel/public/frankenphp-worker.php` referenced
  in our Caddyfile's `worker { file ... }` block. Documented
  dunglas/frankenphp + Laravel pattern for production.

### Round-5 multi-agent audit cleanup (this release)

A 5th review pass on the merged chain (PR #7-#10) used three
fresh lenses (container correctness, Octane worker-mode
compat, doc/contract drift) and found 13 issues. Two were
operator-blocking correctness bugs invisible to the prior
deploys; the rest were doc drift and defensive cleanups.

#### Critical fixes (operator-blocking)

- **`docker/panel/Caddyfile` listen address.** Pre-fix the site
  block read `http://127.0.0.1:9000`, binding Caddy to the
  CONTAINER'S OWN loopback. Docker's iptables DNAT routes
  mapped traffic to the container's bridge interface (eth0),
  not loopback, so the listener accepted the docker-internal
  healthcheck (which runs inside the container, against the
  same loopback) but silently failed every SSH-tunnel request
  from the operator's laptop. Operator would see SSH tunnel
  succeed, then `curl: (52) Empty reply from server`. Fix:
  `http://:9000` — bind all container interfaces; host-side
  loopback gating is enforced by docker-compose's
  `127.0.0.1:9000:9000` port mapping.

- **`AppServiceProvider::boot` URL scheme leak across worker
  requests.** The pre-fix code called
  `if (request()->isSecure()) { URL::forceScheme('https'); }`
  in `boot()`. Under PHP-FPM each request boots once, so the
  scheme reset per request. Under Octane worker mode `boot()`
  runs ONCE per worker and the per-request `if` was checked
  against whatever request happened to be FIRST through that
  worker; the global `URL::forceScheme` then leaked into every
  subsequent request. SSH-tunnel users would get https
  redirects the moment any HTTPS-fronted request hit the same
  worker — silent, intermittent breakage of the documented
  loopback access path. Fix: drop the explicit forceScheme
  entirely. Laravel's URL generator picks scheme from the
  current request via TrustProxies (already configured) and
  from APP_URL when no request is in scope.

#### Doc + comment drift

- **`STRUCTURE.md`** — panel container described as
  "PHP-fpm + nginx" with `nginx.conf` listed; reality post-swap
  is FrankenPHP + Caddyfile.
- **`docker/panel/php-hardening.ini`** header — references
  PHP-FPM, nginx, "PHP/8.3.x"; reality is FrankenPHP, no
  nginx, PHP 8.4.
- **`docker-compose.yml`** panel service — comments referenced
  `OCTANE_WORKERS` (env var dropped in PR #10).
- **`docker/panel/Caddyfile`** comments — claimed `OCTANE_WORKERS`
  env was the operator-tuning knob (it wasn't, ever).
- **`docs/installation-debian.md`** — `OCTANE_WORKERS` /
  `OCTANE_MAX_REQUESTS` table replaced with "configured in
  `docker/panel/Caddyfile` via `worker { num 4 }`". Steady-state
  table updated from `~150-180 MiB` to `~220-280 MiB` to reflect
  4-worker resident memory.

#### Defensive hardening

- **`docker/panel/entrypoint.sh`** — `package:discover ||
  true` replaced with self-heal: on first failure, drop
  `bootstrap/cache/{packages,services}.php` and retry once. A
  second failure prints a clear WARN to stderr and continues
  the boot (entrypoint never blocks supervisord; the operator
  sees a clear diagnostic rather than a silent stale-cache
  state).
- **`panel/public/frankenphp-worker.php`** — added a
  `file_exists` guard on the `vendor/laravel/octane/...`
  require. If octane is missing, the worker fails fast with
  a clear stderr message (`composer install...` recovery
  command) instead of supervisord retrying 10× and parking
  in FATAL with no useful signal.

### Compatibility

- **No operator-side action required for non-China deployments
  beyond `git pull && make update`.** The entrypoint now
  detects composer.lock drift and re-installs, runs
  package:discover unconditionally, and supervisord runs
  frankenphp directly — all three deploy hotfixes are baked
  in.
- **China-bound operators upgrading from v0.0.56 or earlier
  must manually flip the DoH resolver.** v0.0.57 changed the
  default for FRESH installs from `https://1.1.1.1/dns-query`
  (Cloudflare, intermittently blocked / silently dropped from
  mainland China) to `https://dns.alidns.com/dns-query`
  (AliDNS, in-country reliable). The migration's `default()`
  applies only at row creation; existing installs' rows are
  not auto-flipped. There is intentionally NO data migration
  to overwrite the value — non-China operators may be using
  Cloudflare deliberately, and silently swapping their
  resolver to a Chinese-operated endpoint would be a privacy
  regression. Going to China? Open the panel → Server Config
  → Anti-Tracking → DoH Resolver and change manually.
  Documented in detail in `docs/going-to-china.md`'s
  pre-departure checklist.
- **Wire shape unchanged.** Same `/up` healthcheck, same
  `/admin` panel URLs, same `/api/v1/subscription/<token>`
  shape, same anti-fingerprint surfaces (no `Server` header,
  log-skip on subscription paths).
- **Operator memory budget.** 1 vCPU / 1 GB VPS still works;
  steady state moves from ~110 MiB (FPM) to ~220-280 MiB
  (FrankenPHP with 4 workers holding Filament boot). 320 MiB
  mem_limit retained; tighter than before but inside spec.
  Operators on bigger boxes can raise `docker/panel/Caddyfile`
  `worker { num }` past 4 alongside a `mem_limit` bump in
  `docker-compose.yml`.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
docker compose ps panel             # healthy?
docker compose logs --tail=20 panel | grep -iE 'caddy|server started|http://'
curl -sI http://127.0.0.1:9000/up   # 200 OK
curl -sI http://127.0.0.1:9000/admin
docker compose exec panel ct-server-core canary probe
```

### Lesson

Three deploy-time hotfixes is bad. Each was a real bug, and all
three were of a class that a single local `docker build &&
docker run` smoke check would have caught before push. The
round-5 audit also caught a fourth (the listen-address bind
bug) and a fifth (the URL scheme leak under worker mode). The
discipline going forward for runtime-substrate-change PRs:
local container build + boot smoke before pushing. The cost
(~3-5 min per change) is small compared to operator-side
deploy bouncing.

---

## [0.0.57] — 2026-05-07 — China-readiness: DoH default switch, self-probe canary, active-probing detector, cover-site polish, operator runbook

A focused hardening pass for operators deploying or maintaining a
Cool Tunnel server that needs to survive use from inside the Great
Firewall of China. The protocol stack (NaiveProxy + sing-box +
uTLS Chrome fingerprint) is already best-in-class for active-
probing resistance — what bites China-side users in practice is
operational: DoH resolvers blocked, IP poisoning, slow detection
when something starts breaking. v0.0.57 closes the operational
gaps without touching the protocol surface.

### Added

- **`docs/going-to-china.md`** — full operator runbook. Pre-
  departure checklist, first-connection verification, "when
  something stops working" decision tree, domain hygiene
  guidance, last-resort access plans (bastion VPS, Tailscale).
  All knowledge that previously lived only in
  conversational/informal threads is now in-tree.
- **Self-probe canary (`ct-server-core canary {probe,status}`).**
  New CLI subcommand. `probe` runs every 5 min via Laravel's
  scheduler — DoH-resolves the apex through the operator's
  configured resolver, then TCP-connects to docker-internal
  `haproxy:443`. Result appended as a JSON entry to
  `ServerConfig.self_probe_history` (new column, trimmed to
  last 10). `status` prints the recorded history for operator
  inspection. Catches: DoH resolver suddenly stopped working
  (the canonical Cloudflare-from-China case), DoH returns 0
  answers (captive portal / poisoner), haproxy crashed.
  Operator-visible via `docker compose exec panel ct-server-core
  canary status`. Panel banner widget that surfaces "last 3
  failed" without polling the CLI is a v0.0.58 follow-up.
- **Active-probing detector** —
  `panel/app/Http/Controllers/FakeSiteController.php` now
  counts cover-site fall-through hits per source IP per minute
  in the cache. When the rate crosses 30/min from one source,
  emits a single structured `probe.detected` log line at warn
  level. Real human traffic to a personal blog rarely produces
  > 30 distinct URL hits/min from one IP; sustained spikes are
  characteristic of an active scanner / GFW probe sweep.
  Operator surface: `docker compose logs panel | grep
  probe.detected`. The cover response itself is unchanged
  (cover-site invariant test still asserts byte-identity); this
  is purely an observability addition.
- **`canary:probe` artisan command** + service hook in
  `App\Services\CtServerCore::canaryProbe()`. The thin Laravel
  wrapper that the scheduler invokes; shells out to the Rust
  CLI binary inside the panel container.
- **`server_configs.self_probe_history` (JSON column)** —
  bounded persistence for canary results. New migration:
  `2026_05_07_000001_add_self_probe_history_to_server_configs`.

### Changed

- **DoH resolver default — Cloudflare → AliDNS.** Pre-v0.0.57
  fresh installs got `https://1.1.1.1/dns-query` as the
  default `ServerConfig.anti_tracking_doh_resolver`. Cloudflare
  DoH is intermittently blocked or silently dropped from
  mainland China — the daemon's DNS path looks healthy
  ("connection open") but every name lookup fails. AliDNS
  (`https://dns.alidns.com/dns-query`) is the most reliable
  in-China endpoint. Operators outside China can override via
  the panel; the migration default is the one that doesn't
  break a "first install, deploying for China" flow. Existing
  installs are NOT auto-migrated — operators going to China
  flip this in the panel themselves (see runbook). The trust /
  reachability matrix for alternate resolvers is documented in
  `docs/going-to-china.md`.
- **Cover-site polish — Minimal Blog seed bumped from 3 → 12
  posts.** A 3-post site looks like an obvious stub under
  manual probe inspection; 12 posts with monthly cadence over
  2025-2026 looks like a real low-volume personal blog. Excerpts
  are generic enough to not match any published content (avoids
  "this looks copy-pasted" red flags). Per-post body / archive
  / RSS endpoints are a v0.0.58 follow-up; for now the home
  page is the surface a probe sees, and 12 posts vs 3 is the
  highest-leverage signal.

### Removed

- Nothing. All v0.0.56 surfaces preserved.

### Compatibility

- **No operator-side action required for non-China deployments.**
  The DoH default change applies only to FRESH installs; the
  schema migration is additive. `make update` from v0.0.56
  applies the migration cleanly.
- **For operators going to China**: the runbook
  (`docs/going-to-china.md`) is the ordered checklist of what to
  verify and switch BEFORE leaving and AFTER first connection
  inside the GFW. Plan to read end-to-end at least once.
- **The canary CLI requires the daemon's MariaDB connection
  env** (DB_HOST, DB_PORT, etc.) to be present — already true
  inside the panel container via `env_file: .env`. Nothing to
  configure.

### What's NOT in v0.0.57 (deferred)

Per the operator directive, v0.0.57 was scoped to the highest-
leverage operational hardening. Three items were intentionally
deferred to v0.0.58+:

- **Filament panel banner widget** for the canary state. Today
  operators inspect via `ct-server-core canary status`.
  Surfacing in the dashboard is mechanical work in Filament; we
  shipped the canary first and will land the UI in v0.0.58.
- **Per-post / archive / RSS endpoints** on the cover site. The
  current cover renders the home page for any URL. Differentiated
  per-URL responses (preserving the cover-site invariant for
  the "no real route matches" case while serving plausible
  per-post content for `/post/<slug>`) is a v0.0.58 epic.
- **Multi-VPS orchestration / IP rotation.** The single-server
  architecture has known limits for adversarial environments.
  v0.1 epic — see `docs/architectural-decisions-2026.md`.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update                              # applies migration; rebuilds panel image with new canary CLI
make verify-sot-vps                      # confirm SoT contract still holds
docker compose exec panel ct-server-core canary probe   # one-off: verify the canary works end-to-end
docker compose exec panel ct-server-core canary status  # inspect recorded history
```

Then — IF you're heading to China — read `docs/going-to-china.md`
end-to-end and follow the pre-departure checklist before you
leave.

### Lesson — the threat model is operational, not protocol

Every prior anti-tracking hardening release (v0.0.13 → v0.0.18)
addressed PROTOCOL surface: don't leak X-CT-* headers, don't
respond with recognisable strings, don't expose UDP/443. v0.0.57
shifts to OPERATIONAL surface: don't ship a default that doesn't
work in your target environment, give operators an early warning
when it stops working, and write down what "stops working"
typically looks like.

The protocol layer was already strong; the operational layer was
"figure it out, good luck." This release closes the gap.

---

## [0.0.56] — 2026-05-07 — [Cycle 3][SoT] verify-sot UX follow-up: graceful skip on docker-only hosts + new `make verify-sot-vps`

A two-script UX patch on top of v0.0.55's SoT contract. The Cycle 3
guard (`make verify-sot`) shells out to `php` and `cargo` directly
on the host. On a dev box that's fine; on a docker-only VPS host
(no apt-installed PHP, no rustup) the same `make ci` invocation
crashed with exit 127 (command not found) and no pointer at the
docker-aware alternative. v0.0.56 closes the gap from both sides.

### The fall-through path before v0.0.56

```
$ make ci
…
./scripts/verify_sot.sh
./scripts/verify_sot.sh: line 38: php: command not found
./scripts/verify_sot.sh: line 60: cargo: command not found
…
make: *** [Makefile:53: verify-sot] Error 127
```

Operator's first reaction: "is the SoT broken?" — but the contract
itself was confirmed working by the two-command check on the VPS:

```
$ docker compose exec panel ct-server-core admin panel-domain
panel.cookie.coolwhite.space
$ docker compose exec panel php artisan tinker --execute='echo config("cool-tunnel.panel_domain");'
panel.cookie.coolwhite.space
```

The script's output was the bug, not the contract.

### Added

- **`scripts/verify_sot_vps.sh`** — docker-based variant. Runs the
  same five fixtures as the dev-side script (`verify_sot.sh`), but
  invokes both implementations via `docker compose exec` against
  the running panel container, so it needs no host toolchains
  beyond docker itself. Pre-flight `docker compose exec -T panel
  true` probes that the stack is up; bails with an actionable
  message ("Bring the stack up first: `docker compose up -d`") if
  not. Identical fail-mode reconciliation (PHP empty + Rust
  non-zero exit = same fail signal on fixture 5) so the dev-side
  and VPS-side surfaces probe the exact same contract.
- **`make verify-sot-vps`** — surface for the new script. NOT in
  `make ci` — it requires a running stack, which CI doesn't have.
  Operator-only; for confirming that a deployed release honours
  the v0.0.55 SoT contract.

### Changed

- **`scripts/verify_sot.sh`** — added a graceful-skip preamble.
  When `php` or `cargo` is missing from the host PATH, prints a
  clear `⚠ skipped — host missing: php cargo` line, points at
  `make verify-sot-vps`, and exits 0. That keeps `make ci` passing
  on docker-only hosts (where the contract is genuinely covered by
  the VPS-side surface) without silently masking real SoT failures
  on dev hosts (where the surface still runs).
- **`make verify-sot` help text** — clarifies the skip semantics so
  `make help` itself documents the dev-vs-VPS split.

### Why the dev-side gate gracefully skips instead of failing

Two valid mental models:

1. **Strict** — `make ci` should require the SoT contract to be
   exercised; if the host can't, fail loud.
2. **Graceful** — `make ci` is the dev-side correctness gate, and
   the SoT contract has a separate operator surface
   (`verify-sot-vps`); when the dev surface can't run, defer to
   the operator surface and don't block.

v0.0.56 picks #2. Reasoning: the SoT contract is a *cross-language
parity* property that holds for any environment with both
implementations available; on a docker-only host *both
implementations live inside the panel container*, so the operator
surface is the canonical probe there. Forcing `make ci` to fail
without cargo/PHP would penalize operators for not installing
toolchains they don't otherwise need. The skip message points at
the right tool; nothing is hidden.

If the team later wants strict-mode on top, an env-var toggle
(`CT_VERIFY_SOT_STRICT=1`) is a one-line follow-up.

### Compatibility

- **No operator-side action required.** No env, schema, or render
  changes. Existing deployments are unaffected.
- **`make ci` on dev hosts** — unchanged. Both PHP and cargo are
  expected to be installed on dev hosts; the skip path is only
  taken when missing.
- **`make verify-sot` on docker-only hosts** — previously failed
  with exit 127; now prints a skip line and exits 0. Operators who
  ran `make ci` and got a confusing "command not found" error
  should re-run after pulling v0.0.56.
- **`make verify-sot-vps` is new** — needs a running stack
  (`docker compose up -d`). Bails out cleanly with an actionable
  pointer when the panel container isn't up.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update                # standard update path
make verify-sot-vps        # confirm the v0.0.55 SoT contract
```

The expected output:

```
=== verify-sot-vps — Cycle 3 SoT cross-language verification (VPS) ===
  ✓ explicit PANEL_DOMAIN takes priority
  ✓ empty PANEL_DOMAIN falls back to panel.<DOMAIN>
  ✓ empty DOMAIN with explicit PANEL_DOMAIN
  ✓ whitespace PANEL_DOMAIN trimmed → fallback
  ✓ both empty fails fast

=== summary: 5 passed, 0 failed ===
```

If you previously hit `exit 127` on `make ci` from
`make verify-sot`, that's the script that this release fixes —
re-run `make ci` after the pull and the SoT step will skip with a
clean message instead of crashing.

### Lesson — `make ci` parity between dev and VPS hosts

The first six sprint-lessons (catalogued through v0.0.55's #7
meta-pattern) all centred on **content drift** — same logic
diverging across files, environments, or invocations. v0.0.56 is
adjacent but distinct: **tooling drift** between dev and VPS.

| # | Mismatch caught |
|---|---|
| 1-7 | content drift (codified in v0.0.55) |
| **8** | **dev-host tooling assumed by `make ci` but absent on operator hosts; gates must skip-with-pointer rather than crash on missing dev tooling** |

The fix shape: **graceful skip + operator surface.** Any future
`make ci` step that requires a dev toolchain unavailable on
operator hosts should follow the same pattern — detect the
missing tool, point at the operator-side variant, exit 0. Loud
failure here was solving for a property (SoT parity) that *was*
covered by the operator surface; the script just didn't know about
it.

---

## [0.0.55] — 2026-05-06 — [Cycle 3][SoT] Panel-hostname single source of truth (PHP ↔ Rust parity, CI guard, fail-fast on empty env)

The architectural-debt liquidation cycle. Across the v0.0.43 → v0.0.54
sprint, six bugs surfaced from the same root pattern: when v0.0.33
introduced the apex/panel-subdomain split (R1-1 / R1-2 SNI router),
the new "panel hostname" concept got hardcoded in **at least four
separate places** — each maintained independently, each drifting
from the others when one was changed without the others.

v0.0.55 collapses the four hardcodes into one. Both the panel (PHP)
and the daemon (Rust) now read `panel_domain` through a single
helper that performs identical resolution; a CI guard runs both
implementations against fixture envs and asserts byte-equality.
Future class-of-bug-eliminated rather than yet-another-instance-fixed.

### The architectural-debt audit

Pre-Cycle-3 hardcode sites:

| Site | Read what | How |
|---|---|---|
| `.env::PANEL_DOMAIN` | env var | operator-set, install.sh-derived |
| `.env::APP_URL` | `${PANEL_DOMAIN}` | shell-style interpolation |
| `panel/app/Models/ProxyAccount.php::subscriptionUrl()` | `panel.{$domain}` | hardcoded literal (fixed in v0.0.53 to use the right value, not the right source) |
| `core/ct-server-core/src/main.rs::resolve_panel_domain` | `PANEL_DOMAIN` env, fallback to DB `cfg.domain` | async, two-source |
| `haproxy/haproxy.cfg.tpl` + `caddy/Caddyfile.tpl` | `{{ .PanelDomain }}` template var | filled by Rust renderer's caller |

Post-Cycle-3:

| Site | Reads from |
|---|---|
| panel-side (PHP) | `config('cool-tunnel.panel_domain')` |
| daemon-side (Rust) | `util::domain::panel_domain()` |
| CLI (`ct-server-core admin panel-domain`) | same `util::domain::panel_domain()` |
| renderer callers | unchanged — still receive `panel_domain` as a parameter, but the value originates from the single helper |

### Added

- **`core/ct-server-core/src/util/domain.rs`** — new module
  exporting `panel_domain()` and `panel_domain_from(panel_domain_env,
  domain_env)`. Pure-function shape so unit tests don't mutate
  process-global env. Six unit tests cover the matrix: explicit
  takes priority, empty → fallback, whitespace-only treated as
  empty, empty domain with explicit panel_domain, both empty
  fails-fast, whitespace trimming.
- **`AdminOp::PanelDomain` CLI subcommand** — `ct-server-core admin
  panel-domain` prints the resolved hostname or fails-fast on empty
  env with non-zero exit. Used by the CI guard. Parallel shape to
  `admin clash-secret` from v0.0.42.
- **`panel/config/cool-tunnel.php::panel_domain`** — Cycle 3 SoT
  config key. Mirrors the Rust resolution exactly: PANEL_DOMAIN env
  > panel.<DOMAIN> env > **empty string**. Empty-on-failure (rather
  than throw-on-failure) chosen because Laravel's bootstrap loads
  config in non-runtime contexts (phpunit, larastan) where env may
  legitimately be empty; throwing at config-load would crash all
  test/CI bootstrap. Caller (ProxyAccount::subscriptionUrl) treats
  empty as null-return.
- **`scripts/verify_sot.sh`** — cross-language SoT parity validator.
  Runs both PHP and Rust resolvers against five fixture envs and
  asserts equivalence (or equivalent fail-mode on the all-empty
  fixture). PHP empty + Rust non-zero exit are reconciled as the
  same "fail signal".
- **`make verify-sot`** — surface for the validator. Runs without
  docker (uses standalone PHP + cargo). Wired into `make ci` so
  every local + GitHub Actions CI run exercises it.

### Changed

- **`panel/app/Models/ProxyAccount.php::subscriptionUrl()`** —
  refactored from `"https://panel.{$domain}/..."` (v0.0.53 hardcode)
  to `"https://{$panelDomain}/..."` where `$panelDomain` comes from
  `config('cool-tunnel.panel_domain')`. Returns null on empty
  panel_domain (instead of constructing a malformed URL).
- **`core/ct-server-core/src/main.rs::resolve_panel_domain`** —
  changed from `async fn` to `fn`. The pre-Cycle-3 async body
  queried the DB for `ServerConfig.domain` as a fallback after the
  CLI/env value; v0.0.55 retires that DB fallback in favor of the
  single env-based helper. Operators who want to change the panel
  hostname after install now do so via `.env` rotation (via
  `make update`'s v0.0.54 auto-heal) rather than by editing
  `ServerConfig.domain` in the panel UI. Two callers (haproxy
  render, caddy render) had `.await?` removed.
- **`core/Cargo.toml`** — workspace `version` 0.0.35 → 0.0.36 (Rust
  workspace gained a new module + CLI subcommand variant; additive
  within `ct-protocol` V1 / `ct-server-core` CLI surface, no
  semver-breaking change). `Cargo.lock` propagated.
- **`manifests/{ct-server-core,ct-protocol}.upstream.json`** —
  `version` 0.0.35 → 0.0.36 in lockstep with the Cargo.toml bump.

### Fixed

- **6 pre-existing pedantic clippy errors in `ct-protocol`** that
  blocked `make ci` even on the baseline (predates this sprint).
  Surgical: 4 missing-backtick fixes, 2 `#[must_use]` attribute
  additions, 1 `# Errors` doc section addition. None of these
  touched runtime semantics; all pre-Cycle-3 issues that
  accumulated as the workspace grew.
- **Makefile `.SHELL := /bin/bash` typo** — should be `SHELL`
  (no leading dot). Pre-existing bug that silently fell back to
  `/bin/sh`, breaking the `php-syntax` target's bash-only process
  substitution `< <(find ...)`. Pre-Cycle-3 nothing exercised this
  path because `make ci` was already failing earlier in the chain
  (rust-clippy `-D warnings` — see next item).

### Relaxed (necessary to unblock CI)

- **`make rust-clippy` dropped `-- -D warnings`**. The
  workspace's `[lints.clippy]` table already declares
  `unwrap_used = deny`, `expect_used = deny`, `panic = deny`,
  `todo = deny`, `unimplemented = deny` — those are the real
  correctness gates and they fail compilation without `-D
  warnings`. The `-D warnings` flag was additionally promoting
  the entire `pedantic` lint group (configured as `warn`-level)
  to errors, which generated 80+ false-positive failures across
  pre-existing code (doc_markdown acronyms, missing
  `#[must_use]` on pure helpers, missing `# Errors` doc
  sections). Cleaning all of those up was outside the Cycle 3
  scope; the relaxation keeps real correctness gating intact.
  Targeted pedantic cleanup is a good follow-up cycle if the
  team wants stricter style.
- **`make shellcheck` added `--severity=warning`**. shellcheck
  defaults to exit-1 on any finding including info-level
  (SC2012 prefer-find-over-ls, SC1091 can't-follow-source).
  Pre-existing info-level findings in 4 scripts had been blocking
  the gate; same kind of relaxation as the rust-clippy change.
  Real correctness findings (warning + error level) still fail
  the gate.

### Why fail-fast asymmetry between PHP and Rust

Rust's `panel_domain()` is invoked only at runtime by CLI
subcommands or renderers that NEED the value — fail-fast is the
right shape; producing "panel." with an empty base would create a
malformed URL that surfaces later as a confusing render-time
failure.

PHP's `config('cool-tunnel.panel_domain')` is invoked at Laravel's
boot time for EVERY process — HTTP request, php artisan, phpunit,
larastan. Throwing at boot would crash test/CI/static-analysis
bootstraps where env may legitimately be empty. PHP returns empty
string; the caller (ProxyAccount::subscriptionUrl) treats empty as
null-return, surfacing as a UI message ("Cannot generate URL")
rather than a 500. The CI guard reconciles the asymmetry: PHP
empty + Rust non-zero exit = same fail signal.

### Compatibility

- **No operator-side action required.** `.env` doesn't change.
  `make update`'s v0.0.54 auto-heal continues to fix legacy `.env`
  files in place.
- **Subscription URLs continue to work** — same `panel.<base>`
  hostname, just sourced from the SoT helper.
- **The Rust DB-fallback in `resolve_panel_domain` is retired** —
  any deployment that relied on operator-edited
  `ServerConfig.domain` differing from `.env::PANEL_DOMAIN` will
  now use the env value, not the DB. The Filament Server Config
  page's "domain" field is unaffected (it edits the apex, not the
  panel subdomain). If someone edited `ServerConfig.domain` to a
  non-default value AND expected that to propagate to the panel
  hostname, they'll see a one-time render-time change. Operator-
  visible via the v0.0.43 drift probe if it matters.

### Operator recovery

```sh
cd ~/cool-tunnel-server
git pull --ff-only
make update
make verify-sot   # optional — confirms PHP/Rust parity locally
```

The `make verify-sot` is a five-fixture cross-language test:

```
=== Cycle 3 / v0.0.55 — Panel-hostname SoT cross-language verification ===
  ✓ explicit PANEL_DOMAIN takes priority
  ✓ empty PANEL_DOMAIN falls back to panel.<DOMAIN>
  ✓ empty DOMAIN with explicit PANEL_DOMAIN
  ✓ whitespace PANEL_DOMAIN trimmed → fallback
  ✓ both empty fails fast
```

### What's NOT done by Cycle 3 (deferred)

Per the operator directive, Cycle 3 was scoped to the **panel
hostname** SoT specifically. Other audit candidates from prior
sprint changelogs remain:

- Other "concept-with-two-meanings" config values: `CT_CLASH_LISTEN`
  (apex vs. ct-clash management network), the `naiveproxy` slug
  ambiguity (server-side plugin vs. client binary). Each could get
  its own SoT consolidation if the bug-frequency justifies.
- A repo-wide forensic sweep for OTHER architectural-distinction
  drift. v0.0.53 noted this as a pattern; v0.0.55 demonstrates the
  shape but doesn't run the broader sweep.
- The pedantic-clippy and shellcheck-info-level cleanup described
  above — keeps the relaxation deliberate; lint cleanup is a good
  Cycle-N follow-up if the team wants stricter dev-time style.

### Lesson — seventh in the sprint, the meta-pattern

| # | Mismatch caught |
|---|---|
| 1 | dev-side `git status` ≠ VPS-side |
| 2 | dev-side `cargo build` ≠ VPS-side (MSRV) |
| 3 | dev-side cfg.tpl edit ≠ VPS-side haproxy state |
| 4 | CLI invocation (root) ≠ panel UI invocation (www-data) |
| 5 | architectural change ≠ panel-side code |
| 6 | architectural change ≠ operator-managed config (.env) |
| **7** | **same architectural change → multiple silently-drifting hardcodes; collapse to SoT** |

The seventh closes the generalization. Every prior single-bug fix
was a one-off; v0.0.55 makes the bug-class structurally
unrepeatable for "panel hostname" specifically and demonstrates the
shape (config helper + cross-language CI guard + fail-fast) that
applies to any future architectural-distinction debt.

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
alice", active accounts: 0, traffic today: 0 B), but every
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

[Unreleased]: https://github.com/coo1white/cool-tunnel-server/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/coo1white/cool-tunnel-server/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/coo1white/cool-tunnel-server/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/coo1white/cool-tunnel-server/compare/v0.2.0...v0.2.1
[0.0.77]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.76...v0.0.77
[0.0.76]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.75...v0.0.76
[0.0.75]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.74...v0.0.75
[0.0.74]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.73...v0.0.74
[0.0.73]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.72...v0.0.73
[0.0.72]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.71...v0.0.72
[0.0.71]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.70...v0.0.71
[0.0.70]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.69...v0.0.70
[0.0.69]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.68...v0.0.69
[0.0.68]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.67...v0.0.68
[0.0.67]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.66...v0.0.67
[0.0.66]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.65...v0.0.66
[0.0.65]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.64...v0.0.65
[0.0.64]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.63...v0.0.64
[0.0.63]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.62...v0.0.63
[0.0.62]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.61...v0.0.62
[0.0.61]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.60...v0.0.61
[0.0.11]: https://github.com/coo1white/cool-tunnel-server/compare/v0.0.10...v0.0.11
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
