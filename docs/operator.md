# ct-operator

The `ct` operator is a single Bun-compiled binary for Cool Tunnel Server
maintenance commands that need richer runtime checks than shell alone
(`ct doctor`, `ct render`, `ct backup`, `ct restore`, and `ct update`).
It is the main VPS operations surface for installing, updating,
backing up, restoring, and diagnosing the self-hosted proxy server.

The top-level `ct` dispatcher fetches and prefers
`operator/bin/ct-operator-<os>-<arch>` for production commands. Shell
scripts in `scripts/` are thin bootstraps or maintainer/development
helpers, not a second production install/update implementation.

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

From then on, implemented operator commands such as `./ct doctor` and
`./ct render caddyfile` will prefer the binary.

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
| `ct doctor`        | PASS/WARN/FAIL health dashboard. No state mutation. |
| `ct render caddyfile` | Re-render the Caddyfile via `ct-server-core`. |
| `ct render singbox` | Re-render `/data/config/singbox.json` via the panel renderer. |
| `ct backup`        | Snapshot DB, `.env`, manifests, and ACME state. |
| `ct restore <tarball>` | Restore a deployment from a backup tarball. |
| `ct update`        | Pull, load release images, render, hot-swap, and verify the deployment. |
| `ct-operator version` | Print the embedded build version.                                   |

Flags:

- `--json`     — emit structured JSON to stdout instead of human output.

Environment:

- `CT_OPERATOR_DEBUG=1` — debug-level logging on stderr.
## VPS validation procedure

Run after the binary is installed on a real VPS to confirm the
deployment is healthy.

```bash
cd /opt/cool-tunnel-server
./ct doctor
```

A green run has no FAIL rows. Investigate any FAIL before treating the
deployment as healthy.

## Release artifacts

Releases publish:

- `ct-operator-<os>-<arch>` — the binary for each supported target.
- `SHA256SUMS`              — `sha256sum` of each binary.

## Testing

```
cd operator
bun test
bun run typecheck          # tsc --noEmit
```
