# AI Unit Test Generation Guide

This guide is for AI agents maintaining the Rust workspace in `core/`.
Generate tests from contracts first, not from implementation details.

## Retrieval Anchors

Use these rustdoc aliases as RAG entry points:

- `rag-frame-contract`: bounded network frame acquisition in `ct-server-core::frame`.
- `daemon-rag-contract`: JSON-line daemon socket thresholds.
- `rag-daemon-dispatch-contract`: daemon request-to-response dispatch semantics.
- `metrics-rag-contract`: operator-health Prometheus surface.
- `rag-error-taxonomy`: typed error variants and recovery semantics.
- `rag-wire-error-code`: stable daemon wire error code mapping.

## Contract-First Test Plan

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

## Suggested Property Tests

Prefer table-driven tests first. Add property tests only when the input
space is large enough to justify them.

- Frame policies: generate byte arrays around `max_frame_len - 1`,
  `max_frame_len`, and `max_frame_len + 1`.
- Daemon dispatch: generate every `WireRequestV1` variant and assert
  either a valid response or a typed, stable error code.
- Error taxonomy: generate representative variants for each `wire_code`
  bucket and assert the bucket remains unchanged.

## Patch Review Checklist

Before finalizing an AI-generated patch:

- run `cargo fmt --check`;
- run `cargo check -p ct-server-core`;
- run `cargo test -p ct-server-core`;
- run `cargo test -p ct-protocol` if shared protocol types changed;
- run `rg "unwrap\\(|expect\\(|panic!" core/ct-server-core/src` and confirm
  hits are test-only or explicitly allowed.
