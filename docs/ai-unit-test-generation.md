# AI Unit Test Generation Guide

This guide is for AI agents maintaining the Rust workspace in `core/`.
Generate tests from contracts first, not from implementation details.

## Retrieval Anchors

Use these rustdoc aliases as RAG entry points:

- `ai-native-contract`: static semantic metadata in `ct-server-core::contracts`.
- `contract-first-boundary`: trait every explicit module-boundary component implements.
- `consensus-alignment-logic`: project-wide decision principles behind boundary tradeoffs.
- `rag-frame-contract`: bounded network frame acquisition in `ct-server-core::frame`.
- `daemon-rag-contract`: JSON-line daemon socket thresholds.
- `daemon-transport-rag-contract`: connection-scoped daemon recovery contract.
- `heng-pressure-thresholds`: 50% / 80% read-pressure tuning logic.
- `rag-daemon-dispatch-contract`: daemon request-to-response dispatch semantics.
- `metrics-rag-contract`: operator-health Prometheus surface.
- `anti-tracking-rag-contract`: conservative privacy-probe boundary.
- `rag-anti-tracking-contract`: mockable anti-tracking probe trait.
- `canary-rag-contract`: scheduled DoH + TCP self-probe boundary.
- `rag-canary-history-contract`: bounded canary history persistence trait.
- `rag-error-taxonomy`: typed error variants and recovery semantics.
- `rag-wire-error-code`: stable daemon wire error code mapping.

## Contract-First Test Plan

For every type implementing `ContractBoundary`, generate tests that prove:

- `contract().id()` is stable and matches the documented rustdoc alias;
- `recovery_scope()` matches the intended blast radius (`Connection`, `Request`, or `Subsystem`);
- the implementation can be replaced by a local mock when it performs network, process, or database I/O;
- a failure at that boundary is translated into typed output rather than `panic!`, `unwrap`, or process exit.

For every new network boundary, generate tests that prove:

- valid minimal input succeeds without reallocating per request when a reusable buffer is supplied;
- input exactly at the byte cap is accepted only when the delimiter or terminator is present;
- input above the byte cap returns `Error::FrameTooLarge`;
- incomplete input returns `Error::FrameIncomplete` or a boundary-specific 400 response;
- timeout behavior maps to `Error::ReadTimeout` and closes only the offending connection;
- malformed UTF-8 or JSON maps to `bad_request`, not `internal`.

For every new `Error` variant, generate tests that prove:

- `Display` contains operator-actionable context;
- `source()` preserves an underlying error when one exists;
- `wire_code()` maps the variant to a stable machine code;
- the variant is handled at daemon boundaries without panicking.

For every probe-style module, generate tests that prove:

- measurement is separated from persistence or stdout formatting;
- failed reachability emits the same machine-readable JSON keys as success;
- subprocess or TCP startup timeouts map to request-scoped failure;
- privacy checks fail conservatively when an echo endpoint is malformed or unreachable.

For every metrics change, generate tests that prove:

- Prometheus output contains `# HELP` and `# TYPE` for each metric;
- no username, account id, token, or per-user traffic sample is exposed;
- unknown labels or edges are ignored rather than panicking;
- slow or oversized requests return a connection-scoped failure.

## Self-Healing Invariants

AI-generated patches must preserve these invariants:

- One malformed client request cannot terminate `ct-server-core`.
- One slow client cannot hold unbounded memory or unlimited Tokio tasks.
- Operator-health observability remains separate from per-user analytics.
- Config rendering must fail before writing or reloading partial output.
- All network-boundary failures must be typed, recoverable, and documented.
- Boundary traits must stay small enough that generated tests can mock
  them without live Docker, SQLite files, or public internet.

## Suggested Property Tests

Prefer table-driven tests first. Add property tests only when the input
space is large enough to justify them.

- Frame policies: generate byte arrays around `max_frame_len - 1`,
  `max_frame_len`, and `max_frame_len + 1`.
- Daemon dispatch: generate every `WireRequestV1` variant and assert
  either a valid response or a typed, stable error code.
- Heng pressure: generate pressure values around 4999, 5000, 7999,
  and 8000 basis points and assert chunk divisor behavior.
- Error taxonomy: generate representative variants for each `wire_code`
  bucket and assert the bucket remains unchanged.
- Probe contracts: generate mock probe outcomes and assert stdout/persistence
  wrappers preserve the same JSON keys on success and failure.

## Patch Review Checklist

Before finalizing an AI-generated patch:

- run `cargo fmt --check`;
- run `cargo check -p ct-server-core`;
- run `cargo test -p ct-server-core`;
- run `cargo test -p ct-protocol` if shared protocol types changed;
- run `rg "unwrap\\(|expect\\(|panic!" core/ct-server-core/src` and confirm
  hits are test-only or explicitly allowed.
