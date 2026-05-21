# Release-gate stress test

> A green `./scripts/stress/run-all.sh` is the **runtime gate**
> for tagging a release. The static `audit.yml` cycles 31–43 are
> the **build gate**. Both must pass before `git tag vX.Y.Z`.

## The combo workflow

| Where | Role |
| --- | --- |
| **Mac-Claude** (developer laptop) | Repo-side. Long-context architectural reasoning, design intent, CHANGELOG bookkeeping, push to GitHub, tag, release. |
| **VPS-Claude** (production VPS, via `claude` over SSH+tmux) | Runtime-side. Live shell on the actual server. Runs the stress harness, watches `docker stats`, reads logs, iterates on fixes without copy-paste. |

Cadence per release:

1. Mac-Claude pushes feature commits + a CHANGELOG entry.
2. CI cycles 31–43 run automatically on PR. Static gate.
3. VPS-Claude pulls main, recreates the stack, runs
   `./scripts/stress/run-all.sh`. Runtime gate.
4. If runtime gate fails, VPS-Claude reports back to the
   operator who pastes the failure summary to Mac-Claude.
5. Mac-Claude diagnoses, fixes, pushes; loop step 3.
6. Both gates green → Mac-Claude tags `vX.Y.Z` + ships GitHub
   pre-release.

## Test taxonomy

Each live test is one file under `scripts/stress/<letter>_<name>.sh`,
launched by `run-all.sh`. The orchestrator can run a subset by letter,
for example `./scripts/stress/run-all.sh h` when a live `h_*.sh`
exists.

| Letter | Test | What it validates |
| --- | --- | --- |
| **A** | `a_connections.sh` | sing-box's TCP backlog + HTTP/2 multiplexing under 100/500/1000 concurrent CONNECT requests |
| **B** | `b_throughput.sh` | RSS ceiling under sustained traffic (iperf3 over CONNECT for 60s) |
| **E** | `e_cert_renewal.sh` | cert-mtime → render-hash chain reloads sing-box on Caddy renewal |
| **F** | `f_failure_recovery.sh` | Kill sing-box / Redis / MariaDB; what stays up, what auto-recovers |

A, B, E, and F are plan slots. The old C and G scripts were retired
with the pre-v0.4 revocation and Naive/basic-auth runtime. New live
stress tests should land only when they match the current
VLESS+Reality stack. LTSC audit pattern: hand-test once, codify
forever.

## Reading results

Every run drops artifacts in `results/stress/<utc-timestamp>/`:

```
<letter>_<name>.log
<letter>_<name>.json
summary.json                  ← aggregate, machine-readable
```

The JSON files have a uniform shape:

```json
{
  "test": "h_example_runtime_gate",
  "pass": true,
  "reason": "runtime invariant verified"
}
```

`summary.json` rolls them up:

```json
{
  "timestamp": "2026-05-03T14-22-09Z",
  "domain": "proxy.example.com",
  "passed": 2,
  "failed": 0,
  "skipped": 0,
  "tests": [{...}, {...}]
}
```

Mac-Claude reads `summary.json` and uses pass/fail to gate
release tagging.

## Prerequisites on the VPS

The stress harness assumes:

- The full stack is up: `docker compose ps` shows all 5
  containers `Up`.
- `.env` is populated (DOMAIN, DB_*, REDIS_*).
- A panel artisan command `stress:provision` exists that
  idempotently creates a `stress-runner` proxy account and
  prints `{"id": …, "uuid": …}` JSON.

Tests that need workload generators (wrk, vegeta, iperf3) bring
them up via ephemeral containers attached to the project's
`ct-net` network — no host installs required.

## When a stress test catches a regression

LTSC pattern, same as the static audits:

1. Hand-debug the regression. Push the fix.
2. If the regression class is something we'd want to catch
   forever, **add a new stress test letter** for it (or extend
   an existing one). The taxonomy is alphabetical-by-class but
   you can append `H`, `I`, `J` indefinitely.
3. CHANGELOG the new test in the same release as the fix.

## Stress test ≠ load test

This battery proves **functional correctness under realistic
workload**, not "how many users can the box hold." For the
latter, scale the workload generators (more parallel iperf3
clients, longer wrk durations) and watch `docker stats` —
that's a capacity planning exercise, separate concern, not a
release gate.
