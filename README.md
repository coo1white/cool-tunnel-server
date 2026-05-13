# Cool Tunnel Server / Panel

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-1c5cdc)](./LICENSE)
[![LTSC-Heng Draft](https://img.shields.io/badge/license--draft-LTSC--Heng-111111)](./LTSC-HENG-LICENSE-DRAFT.md)
[![Latest release](https://img.shields.io/github/v/release/coo1white/cool-tunnel-server?label=release)](https://github.com/coo1white/cool-tunnel-server/releases)
[![CI](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/ci.yml)
[![Audit](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml/badge.svg?branch=main)](https://github.com/coo1white/cool-tunnel-server/actions/workflows/audit.yml)

Cool Tunnel Server is the VPS-side control plane and proxy ballast for
[Cool Tunnel](https://github.com/coo1white/cool-tunnel). It is built for
a 1 vCPU / 1 GB RAM Debian host and treats low memory as a hard design
constraint, not an afterthought.

This repository is not a hosted VPN business. It is a self-operated
server stack: FilamentPHP for management, FrankenPHP worker-mode for the
application runtime, Rust for deterministic core operations, and Docker
for reproducible orchestration.

Read [Disclaimer.md](./Disclaimer.md) before deployment. You are
responsible for local law, provider terms, and the traffic you route.

## System Contract

| Constraint | Position |
| --- | --- |
| Minimum host | Debian 11/12/13, root SSH, 1 vCPU, 1 GB RAM, ports `80/tcp` and `443/tcp`. |
| Current baseline | `v0.0.89`. Wire format is WireV1; subscription manifests are stable across the 0.0.6x–0.0.8x line. |
| Runtime model | FrankenPHP worker-mode with Laravel Octane. Laravel boot cost is paid once per worker. |
| Core model | `ct-server-core` Rust binary owns rendering, probes, drift checks, the credential-lock invariant, and a Rule Maker daemon FSM with bounded `BytesMut` frames, typed wire errors, and OTel-style network-turn spans. |
| Data posture | Zero user tracking. Internal health metrics are allowed; user data collection is forbidden. |
| Deployment posture | Idempotent shell bootstrap, Docker Compose, pinned manifests, Makefile gates. |
| License posture | Active license: AGPL-3.0-only. Restrictive LTSC-Heng terms are drafted in [LTSC-HENG-LICENSE-DRAFT.md](./LTSC-HENG-LICENSE-DRAFT.md). |

## Architecture Deep-Dive

```mermaid
flowchart LR
    UserTraffic["Web Traffic\nHTTPS / NaiveProxy / Panel"] --> Edge["HAProxy :443\nTCP SNI router"]
    Edge -->|"proxy domain\nraw TLS passthrough"| Proxy["sing-box\nNaiveProxy engine"]
    Edge -->|"panel domain\nTLS to Caddy"| Caddy["Caddy\nACME + reverse proxy"]
    Caddy --> Worker["FrankenPHP Worker Mode\nLaravel + Filament + Livewire"]
    Worker -->|"persistent PDO / Redis clients"| Data["MariaDB + Redis\nDocker-internal"]
    Worker -->|"bounded IPC\nUnix socket / CLI"| Rust["ct-server-core\nRust engine"]
    Rust -->|"render + validate"| Config["Caddyfile / haproxy.cfg\nsing-box config"]
    Rust -->|"reload / probe"| Proxy
    Rust -->|"optional internal only"| Metrics["Internal Health Metrics\nno user labels"]
```

FrankenPHP worker-mode keeps the Laravel application resident. The panel
does not cold-boot the framework on every request, and database/Redis
clients are reused through the worker lifetime where the framework and
driver allow it. This reduces request latency, allocator churn, and CPU
spikes during Filament/Livewire interaction.

The Rust core is the deterministic layer. PHP owns operator workflow and
UI state; Rust owns bounded parsing, config rendering, probe execution,
daemon IPC, and drift-sensitive checks. The design goal is zero-copy in
the operational sense: keep data in typed structures, avoid lossy shell
string pipelines, pass only the minimum frame over IPC, and write final
configuration artifacts atomically.

Daemon connections traverse a connection-local finite state machine — the
Rule Maker. Transitions are atomic compare-exchange and the table is the
only code allowed to choose a successor; an event whose required
predecessor does not match forces `HardReset`. Oversized frames, read
timeouts, malformed UTF-8, and malformed JSON are connection-scoped hard
resets. Valid requests whose domain operation fails still return through
`Responding` as a typed wire error. After every successful turn the
server enters `ProbingConstancy`, measures frame and latency pressure
against an 80% bottleneck threshold, and narrows the next read chunk
under load without raising the hard frame cap. See
[docs/daemon-fsm.md](./docs/daemon-fsm.md) and
[docs/observability-dashboard.md](./docs/observability-dashboard.md).

The stack is intentionally split:

| Layer | Implementation | Duty |
| --- | --- | --- |
| Management UI | Laravel 11, Filament 3, Livewire, Blade | Accounts, panel settings, subscription URLs, operator controls. |
| Application runtime | FrankenPHP + Octane worker-mode | Low boot overhead, long-lived workers, bounded recycle via `MAX_REQUESTS=500`. |
| Engine core | Rust workspace under `core/` | Rendering, probes, component checks, reload decisions, typed IPC. |
| Orchestration | Docker Compose, Makefile, shell scripts | Hardening, rebuilds, health checks, backups, release discipline. |

## First Deploy

End-to-end walkthrough from a freshly-provisioned Debian VPS to a
9/10 `make readiness` PASS. Plan on roughly 15 minutes on a
1 vCPU host, dominated by image build and ACME issuance.

### 0. Prerequisites

- **VPS**: Debian 11 / 12 / 13, root SSH, 1 vCPU, 1 GB RAM,
  ports `80/tcp` and `443/tcp` reachable from the public internet.
  Cloud security groups must allow inbound on both.
- **Two domains** you control:
  - `proxy.example.com` — the public proxy hostname (NaiveProxy
    server, sing-box backend).
  - `panel.proxy.example.com` — the admin panel hostname (Caddy
    backend, FrankenPHP + Laravel + Filament).
- **An email** for Let's Encrypt registration (`acme_email`).
- **Two DNS A records**, both pointing at the VPS public IPv4:

  ```
  proxy.example.com        A    <VPS IPv4>
  panel.proxy.example.com  A    <VPS IPv4>
  ```

  Cloudflare must be **DNS only** (grey-cloud). Do not orange-cloud
  either hostname; the SNI router needs direct TCP reachability and
  a CDN in front will collapse the routing.

  Verify from your workstation before continuing:

  ```bash
  dig +short A proxy.example.com
  dig +short A panel.proxy.example.com
  ```

  Both should return the same VPS IPv4. If they do not, fix DNS
  and wait for propagation before installing.

### 1. Bootstrap

SSH to the VPS as `root` and run:

```bash
curl -fsSL https://raw.githubusercontent.com/coo1white/cool-tunnel-server/main/scripts/bootstrap.sh | bash
```

The bootstrap is idempotent. It installs Docker if absent,
fast-forwards the repository to `/opt/cool-tunnel-server`,
scaffolds `.env` from `.env.example`, and generates strong local
secrets via `openssl rand`. An existing `.env` is preserved.

Output ends with a hint:

```
✓ scaffolded /opt/cool-tunnel-server/.env

  Next:
    1. cd /opt/cool-tunnel-server
    2. $EDITOR .env     # set DOMAIN, PANEL_DOMAIN, ACME_EMAIL
    3. make install
```

### 2. Configure `.env`

```bash
cd /opt/cool-tunnel-server
$EDITOR .env
```

At minimum, set:

```ini
DOMAIN=proxy.example.com
PANEL_DOMAIN=panel.proxy.example.com
ACME_EMAIL=ops@example.com
```

Everything else (`APP_KEY`, `DB_PASSWORD`, `DB_ROOT_PASSWORD`,
`REDIS_PASSWORD`, `CT_CLASH_SECRET_SEED`) was already randomised
by the bootstrap. Leave those alone.

### 3. Install

```bash
make install
```

The install path performs the heavier alignment work: builds the
Rust core image, builds sing-box / HAProxy / panel (with the
embedded core binary), runs Laravel migrations, renders
Caddyfile / `haproxy.cfg` / `sing-box config.json`, verifies the
12 pinned components, and brings the stack up under Docker Compose
hardening. First-run cold build on a 1 vCPU host is typically
5–10 minutes for Rust, 5–6 minutes for the panel image.

Caddy obtains TLS certificates for both hostnames via ACME during
service startup. The certificate-issuance step is what most often
fails on a first install — usually because DNS hasn't propagated
or the cloud security group is blocking port 80.

### 4. Verify

```bash
make status        # docker state, image state, recent errors
make components    # 12 components, all should report OK
make readiness     # 10-check launch gate, target ≥9/10
```

Expected:

- `make components`: 12 rows, all `OK`, including
  `credential-lock` reporting
  `db=rendered=manifest=mac-config ok active_users=0`.
- `make readiness`: `9/10` PASS. The only NG should be check 10
  (`Set LNC_TEST_PROXY_URL=...`) — that's the documented soft-NG
  for the end-to-end probe; it activates once you have at least
  one real proxy account.

### 5. Create the first admin user

```bash
docker compose exec -T panel php artisan ct:make-admin
```

Follow the interactive prompts. Then visit
`https://panel.proxy.example.com/admin` and log in. From there you
can create your first proxy account in the Filament UI.

### 6. Validate end-to-end with the anti-tracking probe

Once you have a proxy account provisioned, the readiness gate's
check 10 becomes runnable:

```bash
USERNAME=<your-account-username>
URL=$(docker compose exec -T -e PROBE_USER="$USERNAME" panel \
  php artisan tinker --execute '
    $a = \App\Models\ProxyAccount::where("username", getenv("PROBE_USER"))->firstOrFail();
    $d = \App\Models\ServerConfig::current()->domain;
    echo "https://{$a->username}:{$a->getCleartextPassword()}@{$d}:443";
  ')
LNC_TEST_PROXY_URL="$URL" make readiness
unset URL LNC_TEST_PROXY_URL
history -d $((HISTCMD-1)) 2>/dev/null
```

Expected: `10/10 (100%) — Result: PASS — ready to ship.`
Check 10 reads `hide_ip + hide_via effective`, validating
HAProxy SNI → sing-box NaiveProxy padding → live cert path →
real upstream end-to-end.

### Unattended path (CI / IaC)

For Ansible / Terraform / cloud-init contexts where the three
env values are already known:

```bash
DOMAIN=proxy.example.com \
PANEL_DOMAIN=panel.proxy.example.com \
ACME_EMAIL=ops@example.com \
AUTO_INSTALL=1 \
curl -fsSL https://raw.githubusercontent.com/coo1white/cool-tunnel-server/main/scripts/bootstrap.sh | bash
```

This chains bootstrap → install in one network round-trip,
skipping the interactive `.env` edit step. The first-admin
creation and end-to-end probe steps still need to happen
post-install.

## Maintaining a Running Deployment

The operator loop after first install. Every step assumes
you're cd'd into `/opt/cool-tunnel-server` (the
[shell alias](#shell-alias-optional) below makes this less
tedious).

### Routine update

```bash
cd /opt/cool-tunnel-server
make backup    # always before a real update
make update    # pulls, rebuilds, renders, runs credential-lock, swaps traffic
make readiness # confirm 9/10 PASS after
```

`make update` is the main production update path. The script:

1. Acquires an exclusive flock so a second operator can't race
   you (v0.0.80 hardening).
2. `git pull --ff-only` to the latest tag.
3. Auto-migrates legacy `.env` shape (PANEL_DOMAIN placement,
   APP_URL hostname) if needed; idempotent on already-canonical
   files.
4. Rebuilds the Rust core + panel + sing-box + HAProxy images.
   Subsequent runs hit the BuildKit cache and finish in seconds.
5. Brings the new panel image up and waits for the entrypoint
   sentinel.
6. Runs Laravel migrations (no-op if nothing pending).
7. Re-renders sing-box config; asserts `ct-server-core guard
   credential-lock` (`db = rendered = manifest = mac-config`)
   — refuses to proceed on drift, without printing passwords.
8. Restarts sing-box for a clean state purge (v0.0.73).
9. SIGHUPs HAProxy for a graceful re-exec.
10. Runs the strict component check on the post-swap runtime.

If anything fails mid-update, the lock auto-releases on script
exit and the script is idempotent — re-run `make update`.

### Backup and restore

```bash
make backup
# → backups/cool-tunnel-<UTC-timestamp>.tar.gz, mode 0600
```

The tarball contains `.env` (all secrets) plus a MariaDB
single-transaction dump plus the Caddy ACME state. **Treat the
file as a secret.** Move it off-VPS to encrypted storage.

To restore on a fresh box:

```bash
make install                                            # first, bring up an empty stack
./scripts/restore.sh backups/cool-tunnel-<timestamp>.tar.gz
make readiness
```

### Reading the panel

- **Filament admin**: `https://panel.proxy.example.com/admin` —
  account CRUD, server config, anti-tracking toggles, fake-site
  selection.
- **Components page**: same UI, surfaces the OK/NG table from
  `ct-server-core component check` with `?` tooltips on every
  metric label.

### Observability

`CT_METRICS_BIND` is opt-in (default empty). The recommended
single-container value is `127.0.0.1:9292` — bind only inside the
panel container or loopback namespace, never on a public
interface. Scrape from inside the trusted Docker boundary:

```bash
docker compose exec -T panel sh -lc 'curl -fsS http://127.0.0.1:9292/metrics'
```

Prometheus scrape config, alert rules, and Grafana panel queries
live in [docs/observability-dashboard.md](./docs/observability-dashboard.md).

Key counters to alarm on:

- `ct_threshold_80pct_crossings_total` — daemon hit the 80%
  bottleneck threshold on frame buffers or latency budget.
- `ct_daemon_fsm_hard_resets_total` — non-zero rate means
  malformed-protocol clients are being rejected.
- `otel_network_turn_latency_milliseconds` — daemon network-turn
  latency distribution.

### Rotating secrets

`.env`-bound secrets (`APP_KEY`, `DB_PASSWORD`, `DB_ROOT_PASSWORD`,
`REDIS_PASSWORD`, `CT_CLASH_SECRET_SEED`) are randomised at
bootstrap. To rotate later (recommended periodically; mandatory
if any operator with `.env` read access leaves the team):

1. `make backup` first. Always.
2. Generate new values with `openssl rand -base64 32` (the typed
   builders in v0.0.25 / v0.0.88 accept any byte pattern including
   `/+=` URL-meta chars).
3. For DB credentials, run `ALTER USER` inside MariaDB **before**
   updating `.env`, then atomically update `.env`, then restart
   redis + panel. The DB ALTER USER → .env update → restart order
   matters; see CHANGELOG `[0.0.x]` rotation playbook entries for
   the precise sequence.
4. **Never rotate `APP_KEY`** without re-generating every account's
   subscription URL and password — the old encrypted
   `password_cleartext_encrypted` blobs become unreadable. Treat
   `APP_KEY` as immutable for the lifetime of the deployment.

### Recovering from a failed update

| Symptom | Recovery |
|---|---|
| `make update` died mid-build (disk full, network drop, SIGHUP) | Re-run `make update`; idempotent, resumes from BuildKit cache. |
| Build fails with `curl: (22) error 404` on upstream tarball | Upstream asset was deleted/renamed. Wait for or open an issue for a manifest pin bump (see v0.0.89 for the pattern). |
| `credential-lock` reports drift | Fix the source row (UI or DB), rerun `make update`. The guard prints the differing party (db / rendered / manifest / mac-config) without leaking passwords. |
| Panel container in restart loop | `docker compose logs --tail=80 panel`; common causes: empty `APP_KEY` (v0.0.81 guard refuses boot), missing `OCTANE_SERVER=frankenphp` (v0.0.81 default), pending migration that failed to apply. |
| `make readiness` reports check 8 NG | Probably a real Redis connectivity issue — the v0.0.86 / v0.0.87 / v0.0.88 fixes hardened this check substantially. If genuinely failing, `docker compose logs panel \| grep -iE 'redis subscriber\|did not parse'` will say why. |

### Shell alias (optional)

After a fresh login the shell starts in `/root`, not the install
dir. Add to `~/.bashrc` to avoid the constant cd:

```bash
cat >> ~/.bashrc <<'EOF'
# Cool Tunnel Server convenience
ct() { (cd /opt/cool-tunnel-server && make "$@"); }
alias ctsh="cd /opt/cool-tunnel-server"
EOF
source ~/.bashrc
```

Then `ct update`, `ct status`, `ct readiness`, `ct backup` work
from any cwd; `ctsh` jumps into the install dir.

## Industrial Makefile

The Makefile is an operator surface, not decoration. Targets fail early
when required tools, manifests, runtime state, or binary alignment are
wrong. This is the **First Scold** rule: the system rejects an invalid
environment before it mutates production state.

| Command | Role |
| --- | --- |
| `make help` | Enumerate the available operator and developer targets. |
| `make build` | Build the Rust workspace in release mode with offline SQLx metadata. |
| `make deploy` | Alias of `make update`; pull, rebuild, migrate, render, verify, and reload. |
| `make update` | Main production update path. |
| `make audit` | Full local audit gate, equivalent to `make ci`. |
| `make ci` | Rust fmt/clippy/test, PHP syntax, Composer audit, shellcheck, manifest checks, SoT parity, supervisord invariants. |
| `make status` | Docker state, image state, embedded core binary presence, recent panel/sing-box errors, certificate presence. |
| `make components` | Run `ct-server-core component check` against pinned manifests. |
| `make readiness` | Execute `scripts/late-night-comeback.sh`, the 10-check operator launch gate (PASS at `9/10`; structural failures cap the score below the threshold). |
| `make verify-sot-vps` | Validate panel-hostname single-source-of-truth from inside the running Docker stack. |
| `make backup` | Snapshot database, `.env`, and Caddy ACME state. |
| `make sbom` | Generate CycloneDX SBOMs for Cargo, Composer, and Docker surfaces. |

`make update` also runs `ct-server-core guard credential-lock` between
the sing-box render and the post-purge component check. The guard
asserts `db = rendered = manifest = mac-config` for every active proxy
account and fails NG without printing passwords. Operators can invoke
it directly:

```bash
docker compose exec -T panel ct-server-core guard credential-lock
```

Developer gates:

```bash
make fmt
make lint
make test
make php-test
make shellcheck
make manifest-lockstep
```

Production operators should run:

```bash
cd /opt/cool-tunnel-server
make status
make components
make readiness
```

## QA Checklist: Operator's Eyes

### Worker Mode Stability Under Load

- [ ] Confirm FrankenPHP is the active panel runtime:
  `docker compose exec -T panel supervisorctl status frankenphp`.
- [ ] Confirm worker recycle guard is present:
  `docker compose exec -T panel sh -lc 'grep -R "MAX_REQUESTS=500" /etc/supervisor* /etc/supervisord.conf 2>/dev/null || true'`.
- [ ] Drive concurrent panel requests from the VPS or a trusted host:
  `for i in $(seq 1 200); do curl -sk https://panel.proxy.example.com/up >/dev/null & done; wait`.
- [ ] During the run, watch memory and restart behavior:
  `docker stats ct-panel ct-db ct-redis ct-singbox ct-haproxy ct-caddy`.
- [ ] Expected: no panel restart loop, no unbounded memory climb, `/up`
  remains HTTP 200, and `make status` reports no recent fatal panel
  errors.

### Filament UI Responsiveness During Config Changes

- [ ] Open `https://panel.proxy.example.com/admin`.
- [ ] Create, disable, and re-enable a proxy account from Filament.
- [ ] Change an anti-tracking toggle or cover-site setting.
- [ ] In parallel, tail the internal workers:
  `docker compose logs -f --tail=80 panel sing-box haproxy`.
- [ ] Expected: Filament remains responsive, Livewire actions complete,
  the Rust renderer emits deterministic config updates, and sing-box
  reloads without a full-stack restart.

### Docker-Internal Health Metrics Visibility

- [ ] Keep public ports limited to `80/tcp` and `443/tcp`:
  `sudo ss -ltnp`.
- [ ] Confirm no metrics port is host-published:
  `docker compose ps` and `docker inspect ct-panel`.
- [ ] `CT_METRICS_BIND` is opt-in (default empty). The recommended
  single-container value is `127.0.0.1:9292` — bind only inside the
  panel container or loopback namespace, never on a public interface.
- [ ] Scrape from inside the trusted Docker boundary only:
  `docker compose exec -T panel sh -lc 'curl -fsS http://127.0.0.1:9292/metrics || true'`.
- [ ] Expected: internal-health counters only. No usernames, account
  IDs, target hosts, subscription tokens, request IDs, or per-user
  destination data. Network-turn timings appear under
  `otel_network_turn_*` and `ct_threshold_80pct_crossings_total`;
  daemon protocol faults appear under `ct_daemon_fsm_hard_resets_total`.
  The Prometheus scrape config, alert rules, and Grafana panel
  queries live in
  [docs/observability-dashboard.md](./docs/observability-dashboard.md).

## Observability Boundary

Allowed:

- Container health, restart count, memory, CPU, and process limits.
- DB pool pressure, semaphore saturation, reload coalescer counters.
- Component drift checks and version pin verification.
- Synthetic anti-tracking probes initiated by the operator.

Forbidden:

- Per-user destination logs.
- Device identifiers.
- Subscription token logging.
- Request correlation IDs that identify a user.
- Metrics labels such as `username`, `account_id`, `target_host`, or
  equivalent identifiers.

Internal health metrics are an operator safety surface. User data
collection is a posture violation.

## Smoke Tests

Run from `/opt/cool-tunnel-server`:

```bash
docker compose ps
make status
make components
make readiness
```

Verify public routing:

```bash
sudo ss -ltnp | grep ':443'
nc -vz proxy.example.com 443
nc -vz panel.proxy.example.com 443
```

Verify proxy behavior with a real account:

```bash
docker compose exec -T panel sh -lc '
URL=$(php artisan tinker --execute '\''$a = \App\Models\ProxyAccount::where("username", "alice")->firstOrFail(); $d = \App\Models\ServerConfig::current()->domain; echo "https://{$a->username}:{$a->getCleartextPassword()}@{$d}:443";'\'')
ct-server-core probe anti-tracking --via "$URL"
'
```

Expected: JSON with `"reachable":true`.

## Services

| Service | Job |
| --- | --- |
| `haproxy` | Public `:443` TCP SNI router. No TLS termination. |
| `sing-box` | NaiveProxy server for the proxy domain. |
| `caddy` | ACME, certificate renewal, panel-domain reverse proxy. |
| `panel` | FrankenPHP worker-mode Laravel/Filament runtime plus Rust core binary. |
| `db` | MariaDB for configuration and account state. |
| `redis` | Cache, queue, and revocation bus. |

## Project Map

| Path | Purpose |
| --- | --- |
| [docker-compose.yml](./docker-compose.yml) | Production topology, hardening, memory limits, internal networks. |
| [.env.example](./.env.example) | Operator configuration surface. |
| [docker/panel/](./docker/panel/) | FrankenPHP, supervisord, PHP hardening, panel image. |
| [panel/app/Filament/](./panel/app/Filament/) | Filament admin UI. |
| [core/ct-server-core/src/](./core/ct-server-core/src/) | Rust control engine. |
| [core/ct-server-core/src/daemon_fsm.rs](./core/ct-server-core/src/daemon_fsm.rs) | Rule Maker connection FSM, atomic transition table, Heng constancy probe. |
| [core/ct-server-core/src/observability.rs](./core/ct-server-core/src/observability.rs) | OTel-compatible network-turn spans, capped hex dumps, 80% threshold helpers. |
| [core/ct-protocol/src/](./core/ct-protocol/src/) | Shared protocol and manifest structures. |
| [sing-box/config.json.tpl](./sing-box/config.json.tpl) | Proxy engine template. |
| [caddy/Caddyfile.tpl](./caddy/Caddyfile.tpl) | Public Caddy template rendered by the panel/core. |
| [haproxy/haproxy.cfg.tpl](./haproxy/haproxy.cfg.tpl) | Public SNI routing template. |
| [manifests/](./manifests/) | Version pins and component verification rules. |
| [manifests/credential-lock.upstream.json](./manifests/credential-lock.upstream.json) | `db = rendered = manifest = mac-config` invariant for `ct-server-core guard credential-lock`. |
| [scripts/](./scripts/) | Bootstrap, install, update, backup, probes, stress gates. |
| [scripts/late-night-comeback.sh](./scripts/late-night-comeback.sh) | The 10-check operator readiness gate (DNS, ports, ACME, UFW, kernel, NTP, components, Redis bridge, cover invariant, anti-tracking probe). |

## License

The active repository license is **AGPL-3.0-only**. See [LICENSE](./LICENSE).

The LTSC-Heng restrictive license is currently a draft for legal review:
[LTSC-HENG-LICENSE-DRAFT.md](./LTSC-HENG-LICENSE-DRAFT.md).

The draft states the intended stricter posture:

- Software is provided **AS IS**.
- Commercial reselling, white-labeling, paid appliance distribution, or
  managed resale requires Sovereign Endorsement.
- Network-operated modifications must remain source-available in the
  AGPL-3.0 spirit.
- 2026 milestone markers, audit markers, and LTSC provenance comments
  must be retained unless the related behavior is removed and documented.
- User tracking expansion is prohibited.

Bundled upstream components retain their own licenses. See [NOTICE](./NOTICE)
and [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).

## Operator References

| Document | Use |
| --- | --- |
| [GETTING_STARTED.md](./GETTING_STARTED.md) | Beginner install path. |
| [docs/installation-debian.md](./docs/installation-debian.md) | Step-by-step Debian 10/11/12/13 install for first-time operators. |
| [docs/operator-runbook.md](./docs/operator-runbook.md) | Update, repair, and incident commands. |
| [docs/architecture.md](./docs/architecture.md) | Deeper system design notes. |
| [docs/components.md](./docs/components.md) | The OK/NG component model and the eleven pinned components. |
| [docs/daemon-fsm.md](./docs/daemon-fsm.md) | Rule Maker text diagram, no-forking rule, Heng constancy logic. |
| [docs/observability-dashboard.md](./docs/observability-dashboard.md) | Prometheus scrape config, alert rules, Grafana panels for `/metrics`. |
| [docs/release-stress-test.md](./docs/release-stress-test.md) | Runtime gate (`scripts/stress/run-all.sh`) for tagging a release. |
| [docs/architectural-decisions-2026.md](./docs/architectural-decisions-2026.md) | Closing record of the 2026 self-audit programme. |
| [docs/cross-platform-clients.md](./docs/cross-platform-clients.md) | Client family roadmap (macOS today, iOS/Android/Windows/Linux planned). |
| [docs/going-to-china.md](./docs/going-to-china.md) | GFW-resistance operator runbook. |
| [docs/ai-unit-test-generation.md](./docs/ai-unit-test-generation.md) | Retrieval anchors and contract-first guidance for AI maintainers. |
| [LTSC.md](./LTSC.md) | Long-term servicing commitments and 2026 milestones. |
| [AUDIT.md](./AUDIT.md) | Audit cycle map and release gates. |
| [SECURITY.md](./SECURITY.md) | Security model and reporting path. |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Contributor rules and code posture. |

<sub>Jurisdiction: Wyoming, USA. Steward: coolwhite LLC.</sub>
