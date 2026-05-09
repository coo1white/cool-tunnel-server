# Daemon Finite State Machine

`ct-server-core` treats every daemon Unix-socket connection as a
single deterministic finite state machine. The FSM is connection-local
and atomically stored; a transition that does not match the required
predecessor is a protocol violation and forces `HardReset`.

## Text Diagram

```text
[Accepted]
    |
    v
[ReadingFrame] -- EOF ----------------------------> [Disconnected]
    |               timeout/too_large/incomplete
    |               invalid transition
    |---------------------------------------------> [HardReset]
    v
[DecodingUtf8] -- invalid utf8 -------------------> [HardReset]
    |
    v
[DecodingJson] -- malformed json -----------------> [HardReset]
    |
    v
[Dispatching] -- domain error --------------------> [Responding]
    |
    v
[Responding] -- write failure --------------------> [HardReset]
    |
    v
[ProbingConstancy] -- tune next turn --------------+
    |                                             |
    +---------------------------------------------+
                       back to [ReadingFrame]
```

## No-Forking Rule

Only one transition branch is authoritative. The implementation uses
`AtomicU8::compare_exchange` so the current state must exactly match
the expected predecessor before a transition can land. If the observed
state differs, the FSM stores `HardReset`, increments
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
- `daemon_fsm::ConnectionFsm::advance`: atomic transition contract.
- `daemon_fsm::ConnectionFsm::probe_constancy`: Heng tuning logic.
- `daemon::handle_client`: network-boundary FSM integration.
