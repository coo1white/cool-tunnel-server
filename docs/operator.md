# ct-operator

A single Bun-compiled binary that replaces three of the more complex
operator shell scripts (`scripts/doctor.sh`, `scripts/fix.sh`,
`scripts/late-night-comeback.sh`) with a unified CLI. Adds a structured
AI incident bridge on failure, a critical-invariant check set
("ballast stones"), and a signed self-update path.

The shell scripts remain in `scripts/` as a fallback. The top-level
`ct` dispatcher prefers `operator/bin/ct-operator-<os>-<arch>` when it
exists, and otherwise execs the legacy `.sh`. No flag day.

## Install

Two paths.

### From a release (recommended)

Download the binary + manifest for your host's architecture from the
[releases page](https://github.com/coo1white/cool-tunnel-server/releases/latest),
verify the SHA-256, and drop it into `operator/bin/`:

```bash
cd cool-tunnel-server
mkdir -p operator/bin
cd operator/bin
ARCH="linux-x64"   # or linux-arm64 / darwin-arm64
curl -fsSLO "https://github.com/coo1white/cool-tunnel-server/releases/latest/download/ct-operator-${ARCH}"
curl -fsSLO "https://github.com/coo1white/cool-tunnel-server/releases/latest/download/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS
chmod +x "ct-operator-${ARCH}"
```

From then on, `./ct doctor` / `./ct fix` / `./ct readiness` will prefer
the binary.

### From source

```bash
cd operator
bun install
bun run build                    # linux-x64 by default
bun run build:linux-arm64
bun run build:darwin-arm64
bun run build all                # every target
```

Bun must be installed (`curl -fsSL https://bun.sh/install | bash`).
The compiled binary bundles the Bun runtime (~60-90 MB depending on
target). It is *not* a Bun runtime replacement — the host still needs
the tools it shells out to (`docker`, `journalctl`, `redis-cli`, etc.).

## Commands

| Command            | What it does                                                           |
|--------------------|------------------------------------------------------------------------|
| `ct doctor`        | PASS/WARN/FAIL health dashboard, including a Ballast Stones group at the end. No state mutation. |
| `ct fix`           | Interactive recipe walker. Same 17 recipes as `scripts/fix.sh`.        |
| `ct readiness`     | Strict ≥9/10 launch gate. Offers tactical retreat / rebuild on fail.   |
| `ct ballast`       | Run the 10 critical-invariant checks only. Exit 0 if no FAIL, 1 otherwise. Cron-friendly. |
| `ct-operator self-update` | Pull a signed binary update from GitHub Releases.               |
| `ct-operator version` | Print the embedded build version.                                   |

Flags:

- `--json`     — emit structured JSON to stdout instead of human output.
- `--no-bridge` — suppress the AI incident-bridge prompt on failure.

Environment:

- `CT_OPERATOR_DEBUG=1` — debug-level logging on stderr.
- `CT_OPERATOR_RELEASE_URL=…` — override the self-update source.

## Ballast stones

Ten invariants the deployment cannot violate. Doctor runs them as part
of its standard pass; the incident bridge also runs them on any task
failure and embeds the results in the AI-paste payload.

1. **panel-container** — `docker compose ps panel` shows it running.
2. **panel-octane-up** — `curl http://localhost:8000/up` returns 200.
3. **redis-ping** — `redis-cli ping` returns `PONG` (via host or
   `docker compose exec redis`).
4. **db-schema-version** — last migration matches the expected name in
   `operator/expected-migration.txt` (skipped if the file is absent).
5. **sqlx-cache** — `cd core && cargo sqlx prepare --check` exits 0.
6. **caddy-acme** — `caddy_data` volume holds a cert for `$PANEL_DOMAIN`
   not expiring in the next 7 days.
7. **singbox-admin** — sing-box admin port reachable via `nc -z`.
8. **haproxy-stats** — `show info` over `/var/run/haproxy.sock`.
9. **sot-parity** — `scripts/verify_sot.sh` agrees (PHP and Rust impls
   of `panel_domain` produce identical output).
10. **ct-core-version** — `ct-server-core --version` matches the version
    pinned in `core/ct-server-core/Cargo.toml`.

Edits to the list live in [src/diag/collectors/ballast.ts](../operator/src/diag/collectors/ballast.ts).

Three consumers, one source of truth:
- `ct doctor` appends the results as a "Ballast Stones" group.
- `ct ballast` runs just these checks (no other doctor noise; cron-friendly).
- The incident bridge embeds them in its payload on any task failure.

## VPS validation procedure

Run after the binary is installed on a real VPS to confirm the
deployment is healthy. Two paths.

### One-shot

```bash
cd /opt/cool-tunnel-server
./ct ballast
echo "exit code: $?"
```

A green run shows ten lines, all `[PASS]`, exit 0. Anything else
means a critical invariant is missing — investigate before
treating the deployment as healthy. `WARN` does **not** flip the
exit code; only `FAIL` does (the deployment is functional but
missing best-practice configuration, vs broken).

### Machine-readable for CI / scripting

```bash
./ct ballast --json --no-bridge > ballast.json
jq -r '.checks[] | "\(.status)\t\(.slug)\t\(.detail // "")"' ballast.json
jq '.overall_ok' ballast.json   # `true` => safe to keep running
```

### Cron alert

```cron
*/5 * * * * cd /opt/cool-tunnel-server && ./ct ballast --no-bridge >/dev/null || curl -fsS -X POST <your-alert-url>
```

The `--no-bridge` flag suppresses the AI incident-bridge prompt so
cron emails don't contain a large pasteable payload; the operator
can reproduce by running `./ct ballast` interactively.

## Incident bridge

On any task failure, the runner gathers an incident-context bundle and
prints it as a pasteable prompt. Suppress with `--no-bridge`.

The bundle includes:

- `host`        — kernel, uptime.
- `ballast`     — the 10 invariant checks above.
- `journal`     — last 100 lines per service (`panel`, `sing-box`,
  `caddy`, `haproxy`, `redis`), via `journalctl` or `docker compose logs`.
- `metrics`     — CPU load, memory, disk usage.
- `proctree`    — `ps axf` filtered to our services.
- `compose`     — `docker compose ps --all --format json` parsed
  per service: name, state (running / exited / created), status
  ("Up 2 hours", "Exited (137) 30 seconds ago"), health, exit
  code. Catches the "container is just gone" failure mode that
  `journal` and `proctree` miss (negative space).

The bridge asks the AI to ground its diagnosis in specific
evidence — cite a ballast check slug, a compose service state,
or a journal line — and to state explicitly what additional
data it would need if the payload is insufficient, rather than
guessing.

Redaction runs on every string-bearing field before output:

- IPv4 addresses → `[ip]`.
- `Authorization: Bearer …` → `Bearer [redacted]`.
- `password=` / `secret=` / `token=` / `api_key=` values → `[redacted]`.
- JWT-shaped strings → `[jwt]`.

The redaction layer is a belt for the careless case, not a defence
against adversaries — operators are responsible for what they paste.

There are no network calls. The bridge writes to stdout (default) or
stderr (`--json` mode); the operator copies into whatever AI they want.

## Self-update trust model

Releases publish three files:

- `ct-operator-<os>-<arch>` — the binary for each supported target.
- `SHA256SUMS`              — `sha256sum` of each binary.
- `SHA256SUMS.sig`          — detached ed25519 signature over `SHA256SUMS`.

When `ct-operator self-update` runs:

1. Fetch `SHA256SUMS` and `SHA256SUMS.sig`.
2. Verify the signature against the ed25519 pubkey baked into the
   current binary at build time (`BUILD_PUBKEY`).
3. Look up the running target's expected hash in the manifest.
4. Fetch the binary, hash it, compare to the manifest.
5. Atomic-rename `<self>.new` → `<self>`.

The single point of trust is the pubkey embedded in the binary.
Anyone who controls that pubkey controls who can sign updates.

### Keygen + CI wiring

```bash
make operator-keygen
```

writes `operator/signing.key` (PEM, ed25519 private key, chmod 600,
gitignored) and prints the base64-encoded raw public key.

- **Private key** → store as the `CT_OPERATOR_SIGNING_KEY` secret in
  the GitHub repo. The `.github/workflows/operator-release.yml`
  workflow uses it to sign `SHA256SUMS`.
- **Public key** is derived from the private key inside the workflow
  (no separate config). Each compiled binary embeds it via
  `--define BUILD_PUBKEY=<b64>`.

A binary built without `CT_OPERATOR_PUBKEY` set will refuse all
self-update attempts (build prints a warning, runtime returns exit 4
with `no pinned pubkey`).

### Rotation

Generate a new keypair, update the GitHub secret, and cut a release.
Operators receive the new signed manifest via `ct-operator self-update`
*using the old key still embedded in their binary* — which means the
NEXT release after rotation must still be signed by the OLD key, with
the new pubkey baked into the binary. After one release cycle, you
can sign with the new key.

This is the same trust-chain handover problem every signed-update
system has. Telemetry through `ct doctor` will tell you when the
fleet has migrated.

## Testing

```
cd operator
bun test                   # crypto roundtrip, env parser, bridge redaction
bun run typecheck          # tsc --noEmit
```

## OPSEC

- The incident bridge is local-only by design. No telemetry, no
  network egress, no API keys. Output goes to stdout for the operator
  to copy.
- Redaction is best-effort; review the payload before pasting if your
  AI assistant retains queries.
- `operator/signing.key` is gitignored; do not commit. If you suspect
  compromise, generate a new keypair and rotate (see above).
