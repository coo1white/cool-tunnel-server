# Components — the OK/NG model

Every replaceable piece of the stack is a **component**: a single
file that pins what we expect, plus a verifier that reports OK or
NG (good or bad). Operators add, swap, or update components like
parts in a machine.

## The eleven components today

| Slug | Kind | What it is | Verifier (post-Cycle-2) |
| --- | --- | --- | --- |
| `caddy` | container-image | Stock Caddy 2 — ACME provider only (Apache-2.0). Manages the TLS cert; sing-box reads it. | HTTP HEAD reachability (informational-only) |
| `ct-protocol` | rust-crate | Shared cross-platform contract | trusted by Cargo.lock |
| `ct-server-core` | binary | Rust engine the panel shells out to | `ct-server-core version` |
| `doh-resolver` | doh-endpoint | RFC 8484 reachability check against `ServerConfig.doh_resolver` (operator-editable, censored-region adapt path) | live DoH query, ANCOUNT > 0 |
| `haproxy` | container-image | TCP/SNI router on :443 (R1-1 / R1-2, v0.0.33). GPL-2.0+. Routes by SNI to caddy:8444 or sing-box:443 without TLS termination. | UNIX stats socket `show info` (v0.0.43) |
| `mariadb` | container-image | DB | authenticated `SELECT VERSION()` (v0.0.41) |
| `naiveproxy` | binary | NaiveProxy server-side architecture — `"type": "naive"` inbound in the rendered sing-box config | grep on `/etc/sing-box/config.json` |
| `naiveproxy-client` | binary | Bundled NaiveProxy client binary (`/usr/local/bin/naive` in panel image) — used by anti-tracking probe | `test -x` (binary present) |
| `panel` | container-image | Filament + Laravel admin | `php artisan ct:version` (v0.0.39) |
| `redis` | container-image | cache + queue + revocation pub/sub | authenticated `redis-cli INFO Server` (v0.0.40) |
| `sing-box` | container-image | Multi-user NaiveProxy server (GPL-3.0). Reads cert from Caddy's volume. | bearer-authenticated clash-API `/version` (v0.0.42) |

The list will grow. The structure won't.

## File format

`manifests/<slug>.upstream.json`. One JSON file per component.
Schema is `ComponentManifestV1` in `ct-protocol::components`.

```json
{
    "name": "sing-box",
    "kind": "container-image",
    "version": "1.13.11",
    "upstream": "https://github.com/SagerNet/sing-box",
    "verify": {
        "command": ["bash", "-c", "set -eo pipefail; SECRET=\"$(ct-server-core admin clash-secret)\"; curl -sf -m 10 -H \"Authorization: Bearer $SECRET\" \"$SINGBOX_CLASH_URL/version\" | jq -r .version"],
        "expect_zero_exit": true
    },
    "note": "GPL-3.0 …"
}
```

`kind` is one of `binary`, `rust-crate`, `container-image`,
`php-package`, `doh-endpoint`. The verifier behaviour differs by
kind:

- `binary` / `container-image` — runs `verify.command` from inside
  the panel container (the panel has no `docker` CLI, so the
  probe cannot itself shell out to other containers — talk to
  them over the docker network instead). The matcher then asserts
  `installed.contains(&m.version)` against `first_line(stdout)`,
  which is how drift detection actually fires: a non-empty first
  line that does NOT contain the pinned `version` flips the
  result to `VersionMismatch`. Cycle 2 (v0.0.39 → v0.0.43)
  rewrote every silenced TCP-open probe in this set into a real
  identity query; see CHANGELOG for the per-component shapes.
- `rust-crate` / `php-package` — trusts the lockfile. The
  verifier marks OK without exec'ing anything; if you want
  stricter, add a custom `verify` block.
- `doh-endpoint` — special-cased to do an RFC 8484 binary DoH
  query against `ServerConfig.doh_resolver` (operator-editable
  via the panel) and assert the response carries ≥1 answer
  record. Catches captive portals / DNS poisoners that 200-OK
  reachability checks would silently pass. (v0.0.22.)

`VerifySpecV1` also carries an `expect_no_version_line: bool`
field (v0.0.37) — opt-out for liveness-only probes that have no
version string to assert. No in-tree manifest uses it post-Cycle-2,
but the field stays in `ct-protocol` for external manifests
(future sidecars, third-party plugins) that legitimately need it.

## Running the check

From inside the panel container:

```sh
ct-server-core component check --manifests /srv/manifests
```

```
 OK  caddy                pinned=v2.8.4          installed=—
 OK  ct-protocol          pinned=0.0.35          installed=0.0.35
 OK  ct-server-core       pinned=0.0.35          installed=0.0.35
 OK  doh-resolver         pinned=operator-config installed=DoH reachable, 1 answer record(s)
 OK  haproxy              pinned=3.0.21          installed=Version: 3.0.21-6e57320bb
 OK  mariadb              pinned=11.8.6          installed=11.8.6-MariaDB-ubu2404
 OK  naiveproxy           pinned=v148.…          installed=v148.… (config grep)
 OK  naiveproxy-client    pinned=v148.…          installed=— (test -x)
 OK  panel                pinned=0.0.39          installed=Cool Tunnel Panel 0.0.39
 OK  redis                pinned=7.4.8           installed=redis_version:7.4.8
 OK  sing-box             pinned=1.13.11         installed=1.13.11
```

Post-Cycle-2 (v0.0.39 → v0.0.46) every container-image probe
emits a real version string the matcher checks against the
manifest pin. Drift between the deployed daemon and the pinned
version surfaces as `VersionMismatch` on the panel Components
page within ~100 ms of a re-check. The only `installed=—` rows
are caddy (informational-only HTTP HEAD reachability — not
slated for drift detection) and `naiveproxy-client` (binary
presence test, no version output). `ct-protocol` and
`ct-server-core` come from the workspace's `Cargo.toml`; the
others are pinned via `make set-component-version COMPONENT=<X>
V=<Y>` (v0.0.45) in lockstep with `docker-compose.yml` /
`docker/<X>/Dockerfile`.

Or: panel → **Components** → big OK/NG table, **Re-check** button.

## Updating a component

Two macros cover every case post-v0.0.45:

**Third-party components** (caddy, haproxy, mariadb, redis, sing-box):

```sh
make set-component-version COMPONENT=redis V=7.4.9
```

The case-block macro bumps every layer that pins this component
in lockstep:

- `docker-compose.yml` `image:` tag (redis, mariadb)
- `docker/<slug>/Dockerfile` `FROM` line (haproxy) or `ARG` (sing-box)
- `docker/panel/Dockerfile` `COPY --from=` (redis-cli only)
- `manifests/<slug>.upstream.json` `version` field

Partial bumps are structurally impossible — a sed-regex bug or
JSON-validation failure leaves all `*.bak` files on disk for
operator rollback.

**In-tree components** (ct-server-core, ct-protocol, panel):

```sh
make set-version V=0.0.X
```

Bumps `core/Cargo.toml::workspace.package.version`,
`core/Cargo.lock`, the three in-tree manifests
(`ct-server-core`, `ct-protocol`, `panel`), and
`panel/config/cool-tunnel.php::version` — what `php artisan
ct:version` emits on the panel — atomically.

**Then in either case:**

```sh
./ct update
```

The script:

- Rebuilds whatever changed.
- Brings the new image up *alongside* the old one (no downtime).
- Runs `ct-server-core component check` against the new container.
- If everything is OK → swaps traffic, retires the old.
- If anything reports NG → rolls back, keeps the old running, prints
  the verifier's diagnostic.

## Adding a new component

When you add a new piece (say, a metrics-shipping sidecar), drop a
new `manifests/<slug>.upstream.json` and `ct update` will
pick it up automatically. The Filament page enumerates the
directory, so it shows up there too without code changes.

## Why this matters

The macOS client already does this for the bundled `naive` binary
via `naive.upstream.json` + `NaiveBinaryResolver`. The server
generalises that idea so:

- Every layer of the stack — UI, glue, engine — has the same lifecycle.
- An auditor can read one directory and know, exactly, what versions
  of what are running.
- A bad swap is caught at the OK/NG check, not in production.
- Every Rust-cored client (current macOS, future iOS / Android /
  Win / Linux) can present the same UI to its operator using the
  same `ComponentManifestV1` definition.
