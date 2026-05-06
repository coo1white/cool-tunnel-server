# Components — the OK/NG model

Every replaceable piece of the stack is a **component**: a single
file that pins what we expect, plus a verifier that reports OK or
NG (good or bad). Operators add, swap, or update components like
parts in a machine.

## The eight components today

| Slug | Kind | What it is | Verifier |
| --- | --- | --- | --- |
| `caddy` | container-image | Stock Caddy 2 — ACME provider only (Apache-2.0). Manages the TLS cert; sing-box reads it. | `caddy version` |
| `sing-box` | container-image | Multi-user NaiveProxy server (GPL-3.0). Reads cert from Caddy's volume. | `sing-box version` |
| `naiveproxy` | binary | NaiveProxy client family — wire-protocol reference (bundled by clients) | (client-side) |
| `ct-server-core` | binary | Rust engine the panel shells out to | `ct-server-core version` |
| `ct-protocol` | rust-crate | Shared cross-platform contract | trusted by Cargo.lock |
| `panel` | container-image | Filament + Laravel admin | `php artisan --version` |
| `mariadb` | container-image | DB | `mariadb --version` |
| `redis` | container-image | cache + queue + revocation pub/sub | `redis-cli --version` |

The list will grow. The structure won't.

## File format

`manifests/<slug>.upstream.json`. One JSON file per component.
Schema is `ComponentManifestV1` in `ct-protocol::components`.

```json
{
    "name": "sing-box",
    "kind": "container-image",
    "version": "1.10.7",
    "upstream": "https://github.com/SagerNet/sing-box",
    "verify": {
        "command": ["bash", "-c", "exec 3<>/dev/tcp/sing-box/443"],
        "expect_zero_exit": true
    },
    "note": "GPL-3.0 …"
}
```

`kind` is one of `binary`, `rust-crate`, `container-image`,
`php-package`. The verifier behaviour differs by kind:

- `binary` / `container-image` — runs `verify.command` from inside
  the panel container (the panel has no `docker` CLI, so the probe
  cannot itself shell out to other containers — talk to them over
  the docker network instead, e.g. a TCP open against
  `/dev/tcp/<service>/<port>` or an HTTP request against the
  service's listener). Optionally checks `expect_stdout_contains`
  and the exit code.
- `rust-crate` / `php-package` — trusts the lockfile. The verifier
  marks OK without exec'ing anything; if you want stricter, add a
  custom `verify` block.

A liveness probe that has no version string to assert should be
**silent on success** (no `expect_stdout_contains`, no echo).
Empty stdout makes `first_line(stdout) → None`, which the matcher
in `core/ct-server-core/src/components.rs::check_one` accepts as
OK. A non-empty first line that does not contain the pinned
`version` flips the result to `VersionMismatch` — the soft
version match is intended for verifiers that print a real
`<tool> version <semver>` line, not for liveness probes.

## Running the check

From inside the panel container:

```sh
ct-server-core component check --manifests /srv/manifests
```

```
 OK  ct-protocol          pinned=0.0.1          installed=0.0.1
 OK  ct-server-core       pinned=0.0.1          installed=0.0.1
 OK  mariadb              pinned=11             installed=—
 OK  naiveproxy           pinned=v147.…         installed=— (client-side)
 OK  panel                pinned=0.0.1          installed=—
 OK  redis                pinned=7-alpine       installed=—
 OK  sing-box             pinned=1.10.7         installed=—
```

The `—` rows are silent liveness probes (post-v0.0.35): they
report OK on TCP / HTTP / artisan-boot success without printing a
version line. Image-tag pinning in `docker-compose.yml` and the
manifest-drift CI guard are the version-of-record for those
components; the verifier confirms the listener is alive, not
which build is behind it. `ct-protocol` and `ct-server-core` keep
real `installed=` strings because their verifiers print a
`<tool> version <semver>` line by design.

Or: panel → **Components** → big OK/NG table, **Re-check** button.

## Updating a component

1. **Bump the manifest.** Edit `manifests/<slug>.upstream.json`,
   change `version` (and `sha256` if pinned).
2. **Bump the build artifact.** Depending on `kind`:
   - **binary** baked into a container — bump the `FROM` tag in
     `docker/<service>/Dockerfile`.
   - **container-image** pulled directly — bump in
     `docker-compose.yml`.
   - **rust-crate** in this workspace — bump in
     `core/Cargo.toml`'s `workspace.package.version`.
3. **Run the update script.**

```sh
./scripts/update.sh
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
new `manifests/<slug>.upstream.json` and `scripts/update.sh` will
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
