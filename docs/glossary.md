# Glossary

Plain-English definitions for every term used across the Cool Tunnel
Server documentation. If you hit a word you don't recognize in
README.md, GETTING_STARTED.md, or any other doc, look it up here.

Sorted alphabetically. Entries cross-link to each other where one
concept depends on another.

---

## ACME

The protocol Let's Encrypt (and similar certificate authorities) uses
to issue TLS certificates automatically. Stands for "Automated
Certificate Management Environment." In this project, [Caddy](#caddy)
runs ACME against Let's Encrypt to get certificates for your domain
on port 80, then writes them to a shared volume that
[sing-box](#sing-box) reads.

If ACME fails, it's almost always one of:
- DNS isn't pointing at your VPS yet (wait for propagation)
- Port 80 isn't reachable from the public internet (firewall, cloud
  security group)
- Let's Encrypt rate-limited you for too many failed attempts in a row

## APP_KEY

A Laravel secret that encrypts every proxy account's stored cleartext
password and signs every subscription manifest. Generated once during
install. **Never rotate it** — rotating makes every existing user's
subscription URL stop working.

## Caddy

A small web server we use as the [ACME](#acme) client + reverse proxy
for the admin panel. Caddy is _not_ on the proxy traffic path — it
only handles certificate issuance + the admin UI. The actual proxy
traffic goes through [HAProxy](#haproxy) → [sing-box](#sing-box).

We pin Caddy in stock configuration (no plugins) — the historical
`forwardproxy` plugin was dropped in v0.0.2 in favor of sing-box.

## Component check

A `ct-server-core` subcommand that walks the 12 pinned manifest files
under `manifests/` and verifies each component (Caddy, HAProxy, MariaDB,
Redis, sing-box, ct-server-core, ct-protocol, naiveproxy, doh-resolver,
credential-lock, panel, naiveproxy-client) reports the expected version.
Each row prints `OK` or `NG`. Run it with `make components` or as part
of `make doctor`.

## ct-server-core

The Rust binary that owns the deterministic-behavior parts of the
server: rendering [Caddy](#caddy), [sing-box](#sing-box), and
[HAProxy](#haproxy) configs from the database; running probes;
checking component drift; the [Rule Maker](#rule-maker) daemon FSM.
Lives at `/usr/local/bin/ct-server-core` inside the panel container.

The [panel](#panel) shells out to it for any work that needs to be
guaranteed-correct rather than fast-to-iterate-on.

## docker compose

The orchestration tool that defines + runs the six-container stack
(panel, sing-box, caddy, haproxy, db, redis) from `docker-compose.yml`.
"Compose v2" — the modern subcommand form (`docker compose up`), not
the older Python-based `docker-compose`.

## .env

The single config file at the root of the repo (`/opt/cool-tunnel-server/.env`).
Contains every secret + tunable: `DOMAIN`, `PANEL_DOMAIN`, `ACME_EMAIL`,
`APP_KEY`, `DB_PASSWORD`, `REDIS_PASSWORD`, `CT_CLASH_SECRET_SEED`, etc.
Mode 0600 (readable by root only). Backed up as part of `ct backup`.

## entrypoint

A shell script (`docker/panel/entrypoint.sh`) the panel container runs
on every start. It does first-boot setup that can't go in the image:
generate APP_KEY if missing, wait for DB to be ready, run migrations,
render initial Caddyfile + sing-box config, then hand off to
[supervisord](#supervisord).

If the panel container restart-loops, the entrypoint failed somewhere.
`docker compose logs --tail=80 panel` shows the failing line.

## Filament

The admin-panel UI framework built on top of [Laravel](#laravel) and
Livewire. Provides the resource pages, forms, tables, and dashboards
you see at `https://<PANEL_DOMAIN>/admin`. The Filament code lives
under `panel/app/Filament/` and is the part operators interact with
most.

## flock

A Linux file-locking primitive `update.sh` / `install.sh` use to
prevent two operators from running the update at the same time and
clobbering each other. The lock is per-project (`/tmp/cool-tunnel-
ops-<project>.lock`) and auto-releases on script exit. v0.0.80
hardening.

## FrankenPHP

The PHP runtime we use, combining [Caddy](#caddy) + PHP in a single
process. We run it in _worker mode_ (a Laravel-specific optimization):
the Laravel framework is booted once per worker process and reused
across many HTTP requests, instead of cold-booting on every request.
~3-5x faster panel response times compared to traditional FPM.

The recycle is bounded — workers process up to `MAX_REQUESTS=500`
requests before respawning, which limits memory leak blast radius.

## FSM

Finite-state machine. The [Rule Maker](#rule-maker) is one. Used in
this project to describe a connection's lifecycle through a fixed
set of states with explicit allowed transitions.

## GFW

The Great Firewall of China. The state-operated filtering system the
project is hardened against. See
[docs/going-to-china.md](./going-to-china.md) for the operator
runbook on deploying inside it.

## HAProxy

A TCP-level routing daemon on port 443. It looks at the
[SNI](#sni) (Server Name Indication) of an incoming TLS
ClientHello, without terminating TLS, and forwards the entire TCP
stream to either [sing-box](#sing-box) (proxy traffic, raw TLS
passthrough) or [Caddy](#caddy) (admin-panel traffic). The split
keeps the proxy domain indistinguishable from a normal HTTPS site
to anyone who's only seeing the TLS handshake.

## Laravel

The PHP web framework the admin panel is built on. Version 11. We
use it together with [Filament](#filament) (UI), Livewire (reactive
forms), and [FrankenPHP](#frankenphp) (worker-mode runtime).

## NaiveProxy

The proxy protocol clients use to connect. HTTP/2 CONNECT over TLS,
with traffic padding that makes it look like normal HTTPS browsing
on the wire. [sing-box](#sing-box) speaks NaiveProxy as a server;
the upstream `naive` Go binary speaks it as a client.

The traffic-padding feature is what makes it
[GFW](#gfw)-resistant — pure HTTPS would be too obviously different
in packet timing + size from typical web browsing.

## Octane

The Laravel package that enables worker-mode runtime. Pairs with
[FrankenPHP](#frankenphp). Together they keep the framework resident
across requests instead of cold-booting per request.

## OK / NG

The two-state result of a [component check](#component-check). `OK`
means the installed component matches its pinned version. `NG` means
it doesn't (either a version mismatch or a verify probe failure). The
post-update component check refuses to declare success on any NG.

## panel

The Docker container that runs the admin UI (Laravel + Filament +
FrankenPHP), plus the [ct-server-core](#ct-server-core) Rust binary.
The most operator-visible service: `docker compose exec panel ...`
is how you run almost every admin command.

## PANEL_DOMAIN

The subdomain you log into the admin UI from. Usually `panel.<DOMAIN>`.
A separate domain from [DOMAIN](#domain) so the [HAProxy](#haproxy)
SNI router can distinguish them. Set in [.env](#env).

## Rule Maker

The connection-local FSM inside [ct-server-core](#ct-server-core)'s
daemon. Each daemon connection moves through states like `Greeting →
Reading → Routing → Responding → ProbingConstancy` with explicit
allowed transitions; any out-of-sequence event forces a connection-
scoped `HardReset`. Atomic compare-exchange transitions guarantee no
two events can race for the same state.

See [docs/daemon-fsm.md](./daemon-fsm.md) for the text diagram + the
no-forking rule.

## sing-box

The proxy engine that speaks [NaiveProxy](#naiveproxy) on `:443` to
end-user clients. Reads the TLS certificate [Caddy](#caddy) writes
to a shared volume; speaks the actual proxy protocol on the
[HAProxy](#haproxy)-routed traffic.

Open-source, GPL-3.0. Pinned to a specific version in `manifests/sing-box.upstream.json`.

## SNI

Server Name Indication. The TLS extension that lets a client tell
the server which hostname it's trying to reach _during the
handshake_, before any HTTPS data is exchanged. [HAProxy](#haproxy)
reads the SNI to decide whether to route a connection to
[sing-box](#sing-box) (proxy domain) or [Caddy](#caddy) (panel
domain).

## subscription manifest

A JSON document the admin panel emits at a per-user secret URL,
describing how to connect to the proxy (server, port, auth, etc.).
Client apps fetch it on first login and use it to configure
themselves. The shape is pinned in `core/ct-protocol/` and stable
across the 0.0.6x-0.0.9x line.

## supervisord

A Python-based process supervisor running inside the panel container.
Manages five long-running processes: FrankenPHP (the web server),
queue worker (Laravel), Messenger worker (Symfony), scheduler
(Laravel cron equivalent), and ct-core-daemon (the
[Rule Maker](#rule-maker) IPC daemon).

If [doctor](#doctor) reports `5/5 programs running`, supervisord
is healthy.

## TLS

Transport Layer Security. The encryption layer underneath HTTPS. Both
the admin panel ([Caddy](#caddy)) and the proxy ([sing-box](#sing-box))
terminate TLS on `:443` — the only difference is what's behind it.

## TTL

Time To Live. In DNS, how many seconds a resolver may cache an `A`
record before re-querying. We recommend `300` (5 min) on the records
pointing at your VPS during initial setup, so DNS changes propagate
quickly while you're debugging.

## VPS

Virtual Private Server. A small Linux machine you rent from a cloud
provider (RackNerd, Hetzner, Vultr, DigitalOcean, etc.) for a few
dollars a month. The minimum spec the project supports is 1 vCPU /
1 GB RAM / 10 GB disk.

## Wire format / WireV1

The JSON shape of the data passed between the panel and clients
(subscription manifests, profile updates). Pinned in
`core/ct-protocol/`. Stable across the 0.0.6x-0.0.9x release line —
older clients keep working when the server updates.

---

## doctor

The operator health-dashboard command added in v0.0.98. Run with
`make doctor`. Prints ~13 PASS / WARN / FAIL rows across DNS, ports,
ACME, container health, supervisord, disk, RAM, etc. Each FAIL row
comes with a one-line "what to do next" hint.

Different from [readiness](#readiness) — `doctor` is "show me everything
I should look at"; `readiness` is the strict ship-readiness gate.

## readiness

The 9-check operator-launch gate (`scripts/late-night-comeback.sh`).
Strict: requires ≥8/9 checks PASS, with structural fails capping the
score at 7. Suitable for cron / CI. The historical name comes from
the original use case — checking a VPS was ready to publicly launch
late at night before flipping DNS.

Different from [doctor](#doctor); see above.

## help-<topic>

A `make help-<topic>` target added in v0.0.99. Prints a one-screen
mini-manual for an operator script. `make help-topics` lists the
available topics; each one (`getting-started`, `install`, `update`,
`doctor`, `readiness`, `backup`, `restore`, `troubleshooting`) is a
plain-English explanation of what the corresponding script does + the
common failure modes.

---

## DOMAIN

The subdomain end-users connect to with their proxy clients. Usually
something like `proxy.example.com`. Set in [.env](#env). See also
[PANEL_DOMAIN](#panel_domain).
