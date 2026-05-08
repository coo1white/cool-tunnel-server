<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Contributing

This document codifies the testing and documentation patterns the
codebase already follows, so a new contributor (or a future
maintainer revisiting cold) can extend the project without first
reverse-engineering the conventions.

The contract this guide serves: [`LTSC.md`](./LTSC.md) — the
project's published commitments, audit rhythm, and 2026
milestones (Immutable Ballast, Zero `unwrap()` floor, Zero
blocking-syscall floor, Zero leak / bounded-spawn posture). Every
pattern below is a way to keep that contract honest at code-edit
time rather than at audit time.

---

## Documentation patterns

### Module rationale lives in `//!` blocks

Every module's top-of-file (after the SPDX header) carries a
`//!` block describing **why** the module exists, **what** it
contracts to do, and **what it explicitly is not**. These blocks
render in `cargo doc --open` as the module's landing page.

Example anchor: [`util/debounce.rs`](./core/ct-server-core/src/util/debounce.rs)
opens with the design rationale for the 100 ms Coalescer window
(why not 50 ms, why not 250 ms, what breaks at each end).

Convention:
- Line 1: SPDX header — stays as `//`, never `//!`
- Lines 2..N: module rationale in `//!` blocks; every constant
  threshold or concurrency cap explains its choice rationale
- The `//!` block IS load-bearing per the **Immutable Ballast**
  principle (`LTSC.md § 2026 milestones`). Don't strip it because
  it looks long; strip it only if you've traced its referenced
  versions through `CHANGELOG.md` and confirmed the incident is
  no longer relevant.

Pre-v0.0.66 most modules used `//` (regular comments — invisible
to `cargo doc`). The v0.0.66 pivot converted them to `//!` so the
rationale is browsable. New modules should follow `//!` from
inception.

### Item docs use `///`

Public items (functions, types, constants) document their
contract with `///`. Private items use `///` when the rationale
is non-obvious; otherwise a short `// ` inline comment is fine.

For numeric constants whose choice is non-obvious (timeout
windows, concurrency caps, retry budgets), the `///` block must
include the *reason* the value is what it is, not just what the
value does. Example: `daemon.rs::MAX_CONCURRENT_HANDLERS = 16`
documents why 16 (`2 × FrankenPHP worker count`), not just that
it's a cap.

---

## Testing patterns

### Lint-floor escape hatch in `#[cfg(test)]` modules

The workspace denies `unwrap_used`, `expect_used`, `panic`,
`todo`, `unimplemented` at deny-level. Test code is the one place
these are tolerated — a test that can't fail loudly with `unwrap`
is harder to read for very little gain. Every test module
re-allows them explicitly:

```rust
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    // ...
}
```

The pattern is structural: the `#[allow(...)]` attribute
documents that the relaxation is **scoped to test code only**.
Production code stays under the floor. Don't move the
`#[allow(...)]` to a wider scope (crate-level, or
`#![cfg_attr(test, allow(...))]` on the crate root) — that hides
the relaxation and lets it leak into a future refactor.

### `#[test]` vs `#[tokio::test]`

| When | Macro | Why |
|---|---|---|
| Pure state-machine property (no `.await`) | `#[test]` | Faster; deterministic; no runtime startup cost. |
| Anything that calls `async fn` or `.await`s | `#[tokio::test]` | Required for `.await` in test body. |
| Concurrent stress (multiple tasks racing into shared state) | `#[tokio::test(flavor = "multi_thread", worker_threads = N)]` | The default single-thread flavor serializes spawned tasks; only multi-thread exercises actual race conditions on `Arc<Mutex<...>>`. |

**Pin the flavor explicitly when concurrency is the property
being tested.** The Coalescer's
`coalescer_concurrent_admits_collapse_correctly`
([`util/debounce.rs`](./core/ct-server-core/src/util/debounce.rs))
uses `flavor = "multi_thread", worker_threads = 4` because it
asserts a property under contention; running it on the default
single-thread flavor would mask any latent serialization bug.

### Stress tests vs property tests

| Shape | Purpose | Example |
|---|---|---|
| **Property test** | Asserts a *contract* (e.g., "this state machine never returns X twice without an intervening Y"). Small inputs; deterministic. | `coalescer_first_event_fires_now_and_schedules_flush` |
| **Stress test** | Asserts the property *survives load* (1M events, 100k events, 64-task contention). Catches O(N²) accidents and lock-ordering bugs. | `debouncer_stress_collapses_burst_to_one_per_window` (1M-event burst), `coalescer_stress_burst_collapses_to_at_most_two_fires` (100k-event burst), `coalescer_concurrent_admits_collapse_correctly` (64 tasks × 1000 events) |

**A stress test should never simulate "real" production load —
it should simulate *adversarial* load that the property must
survive.** The Coalescer's contract is "≤ 2 fires per window
regardless of N"; the stress test pushes N to 100k+ events to
make any silent O(N) regression scream.

### When to add a codified audit cycle vs a one-off test

This codebase has two kinds of automated correctness checks:

1. **Tests** (`cargo test --workspace`) — run on every CI build.
   Verify the *behaviour* of code as committed.
2. **Audit cycles** (`audit.yml`, weekly + per-PR) — run on a
   slower cadence. Verify *cross-cutting properties* the test
   suite can't easily express (RustSec advisories, stale-doc
   leak-back, manifest drift, license diff).

The decision rule:
- One occurrence of a class of bug → **fix it, write a test for
  the specific case**. Don't generalize prematurely.
- Two occurrences of the same shape across releases → **codify
  it**. Add a check to `audit.yml` (a new "Cycle N" — see
  `AUDIT.md` for the numbering scheme), update `LTSC.md` if it's
  cross-cutting, document the rotation policy.

The single-occurrence first-fix discipline is deliberate: the
audit suite is the project's slow-but-permanent memory, and
adding a check has maintenance cost. Wait until the second sighting.

### Test naming convention

Tests are named for the *property* they assert, not the *function*
they exercise. Read like specifications:

- ✅ `burst_collapses_to_two_fires`
- ✅ `repeated_leading_edges_stay_single_flight`
- ✅ `error_msg_carries_call_site_in_display`
- ❌ `test_admit` (just names the function under test)
- ❌ `test_works` (says nothing)

A failing test's name should already tell the reader what
contract was violated, before they look at the assertion.

---

## Async patterns (post-v0.0.65)

### Lock choice: `std::sync::Mutex` vs `tokio::sync::Mutex`

The compile-time guarantees differ:

| Lock | When to use |
|---|---|
| `std::sync::Mutex` | Critical section is brief and never crosses `.await`. The `MutexGuard` is `!Send`, so the compiler **prevents** holding it across an await point. This is the structural guarantee. |
| `tokio::sync::Mutex` | Critical section legitimately spans `.await` (rare; prefer redesign). The async-aware lock yields cooperatively. |

**Default to `std::sync::Mutex`.** If a future contributor finds
themselves writing `.lock().await` followed by an `.await` on the
locked data, that's the signal to redesign — not to reach for
`tokio::sync::Mutex`. The Coalescer migration (v0.0.65 T-4) is
the worked example.

### Spawn cardinality

Every `tokio::spawn` site must declare its cardinality bound at
the call site or in a surrounding module docstring. The current
production sites are listed in
[`LTSC.md § Zero leak (bounded-spawn) posture`](./LTSC.md). New
spawn sites must add a row to that table or be visibly bounded
by a permit / handle-check / per-process singleton.

If a spawn's cardinality cannot be bounded, it doesn't ship.

---

## Commit + PR flow

- Branch off `main`. Naming: `feat/v0.0.X-...`, `fix/...`,
  `chore/...`, `docs/...` — see recent merged PRs for examples.
- Run `cargo fmt --all`, `cargo test --workspace --locked`, and
  `cargo doc --no-deps --workspace` locally before pushing.
- For PHP changes: `cd panel && vendor/bin/pint --test`.
- Commit messages: type-scoped subject (`feat(panel): ...`,
  `fix(daemon): ...`), body explaining *why* the change exists,
  not what it does (the diff shows what). Past commits follow
  this shape.
- Wait for CI green before merging. The single exception is
  `--prerelease` GitHub releases that ship operator-validated
  separately (see `RELEASE.md`).

---

## What this document is NOT

- A style guide. `cargo fmt` + `vendor/bin/pint` are the style
  guides. They run in CI; if either fails, the change doesn't ship.
- A complete reference. The contract is `LTSC.md`. The audit
  cycles are `AUDIT.md`. The release ritual is `RELEASE.md`. This
  file documents the *patterns* that hold those three together at
  the code-edit layer.
- A recommendation system. There's no `try this` for unfamiliar
  cases. Where the codebase has a single deliberate pattern
  (locks, spawn cardinality, `//!` docs), this file names it and
  expects new code to match. Where it doesn't, code review is the
  resolution path.
