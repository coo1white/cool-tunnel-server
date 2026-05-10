# Daemon Finite State Machine

`ct-server-core` treats every daemon Unix-socket connection as a
single deterministic finite state machine. The FSM is connection-local
and atomically stored; callers submit named protocol events, and the
Rule Maker transition table is the only code allowed to choose the
next state. An event that does not match the required predecessor is a
protocol violation and forces `HardReset`.

## Text Diagram

```text
[Accepted] -- StartReading ----------------------> [ReadingFrame]
[ReadingFrame] -- PeerClosed --------------------> [Disconnected]
    |               timeout/too_large/incomplete
    |               invalid event / transition
    |---------------------------------------------> [HardReset]
    |
    | FrameComplete
    v
[DecodingUtf8] -- invalid utf8 -------------------> [HardReset]
    |
    | Utf8Decoded
    v
[DecodingJson] -- malformed json -----------------> [HardReset]
    |
    | JsonDecoded
    v
[Dispatching] -- domain error --------------------> [Responding]
    |
    | Dispatched
    v
[Responding] -- write failure --------------------> [HardReset]
    |
    | ResponseWritten
    v
[ProbingConstancy] -- tune next turn --------------+
    |                                             |
    | ConstancyProbed                             |
    +---------------------------------------------+
                       back to [ReadingFrame]
```

## No-Forking Rule

Only one transition branch is authoritative. `daemon_fsm::ConnectionEvent`
is the Rule Maker's protocol vocabulary; `ConnectionFsm::apply` maps
each event to exactly one `(expected_state, next_state)` pair and then
uses `AtomicU8::compare_exchange` so the current state must exactly
match that expected predecessor before a transition can land. If the
observed state differs, the FSM stores `HardReset`, increments
`ct_daemon_fsm_hard_resets_total`, and the connection closes.

Malformed UTF-8, malformed JSON, incomplete frames, read timeouts, and
oversized frames are connection-scoped hard resets. Domain-level
failures after a valid request still produce a typed wire error and
return through `Responding`, because the client followed the protocol.

## Initiative Logic: Heng Constancy

The server actively probes every successful turn after `Responding`.
The `ProbingConstancy` step measures:

- request-frame pressure as frame bytes divided by the hard frame cap;
- latency pressure as turn latency divided by a 1 second operator
  control-plane budget.

The higher pressure wins. Below 50%, the next turn uses the normal
8 KiB read chunk. At 50% it halves the chunk. At 80% it quarters the
chunk and emits a warning. This never raises the hard protocol cap; it
only makes pressured connections yield more often to the Tokio runtime.

## RAG Retrieval Anchors

- `daemon_fsm::ConnectionState`: complete state taxonomy.
- `daemon_fsm::ConnectionEvent`: Rule Maker protocol vocabulary.
- `daemon_fsm::ConnectionFsm::apply`: atomic transition contract.
- `daemon_fsm::ConnectionFsm::probe_constancy`: Heng tuning logic.
- `daemon::handle_client`: network-boundary FSM integration.
