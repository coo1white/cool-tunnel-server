// SPDX-License-Identifier: AGPL-3.0-only
//! Deterministic daemon connection state machine.
//!
//! The daemon wire protocol is intentionally small: one JSON object
//! per line on a Unix socket. This module makes that transport
//! contract explicit as a finite state machine so there is a single
//! authoritative branch of truth for every connection turn.
//!
//! # Project Decision Logic
//!
//! A cooperative panel client follows one path:
//!
//! `Accepted --StartReading--> ReadingFrame --FrameComplete-->
//! DecodingUtf8 --Utf8Decoded--> DecodingJson --JsonDecoded-->
//! Dispatching --Dispatched--> Responding --ResponseWritten-->
//! ProbingConstancy --ConstancyProbed--> ReadingFrame`
//!
//! Any observed state that differs from the required predecessor is a
//! protocol violation or a code bug. The only recovery is
//! [`ConnectionFsm::hard_reset`], which records the violation and
//! moves the connection to a terminal state. That is the No-Forking
//! Rule: the transport never speculates about alternate histories.
//!
//! # FSM Diagram
//!
//! ```text
//! [Accepted] -- StartReading ----------------------> [ReadingFrame]
//! [ReadingFrame] -- PeerClosed --------------------> [Disconnected]
//!     |               timeout/too_large/incomplete
//!     |               invalid event / transition
//!     |---------------------------------------------> [HardReset]
//!     |
//!     | FrameComplete
//!     v
//! [DecodingUtf8] -- invalid utf8 -------------------> [HardReset]
//!     |
//!     | Utf8Decoded
//!     v
//! [DecodingJson] -- malformed json -----------------> [HardReset]
//!     |
//!     | JsonDecoded
//!     v
//! [Dispatching] -- domain error --------------------> [Responding]
//!     |
//!     | Dispatched
//!     v
//! [Responding] -- write failure --------------------> [HardReset]
//!     |
//!     | ResponseWritten
//!     v
//! [ProbingConstancy] -- tune next turn --------------+
//!     |                                             |
//!     | ConstancyProbed                             |
//!     +---------------------------------------------+
//!                       back to [ReadingFrame]
//! ```
//!
//! The "initiative" step is not a passive health check. After each
//! successful turn, the daemon probes observed latency and frame
//! pressure and computes the next turn's constancy profile. Current
//! read limits remain hard protocol constants; Heng tuning narrows or
//! widens the next read chunk inside those hard limits.

use crate::observability::utilization_basis_points;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::time::Duration;

/// Daemon connection states encoded for atomic storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
#[doc(alias = "daemon-fsm-state")]
#[doc(alias = "no-forking-rule")]
pub enum ConnectionState {
    /// Socket was accepted and has not consumed a request turn yet.
    Accepted = 0,
    /// Awaiting one bounded newline-delimited frame.
    ReadingFrame = 1,
    /// Validating that frame bytes are UTF-8.
    DecodingUtf8 = 2,
    /// Decoding UTF-8 text into `WireRequestV1`.
    DecodingJson = 3,
    /// Dispatching the decoded request through the contract boundary.
    Dispatching = 4,
    /// Serializing and writing a `WireResponseV1`.
    Responding = 5,
    /// Active post-turn probe that tunes the next read strategy.
    ProbingConstancy = 6,
    /// Peer closed cleanly with no buffered partial request.
    Disconnected = 7,
    /// Terminal protocol violation or transport fault.
    HardReset = 8,
}

impl ConnectionState {
    #[must_use]
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::ReadingFrame => "reading_frame",
            Self::DecodingUtf8 => "decoding_utf8",
            Self::DecodingJson => "decoding_json",
            Self::Dispatching => "dispatching",
            Self::Responding => "responding",
            Self::ProbingConstancy => "probing_constancy",
            Self::Disconnected => "disconnected",
            Self::HardReset => "hard_reset",
        }
    }

    #[must_use]
    fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Accepted,
            1 => Self::ReadingFrame,
            2 => Self::DecodingUtf8,
            3 => Self::DecodingJson,
            4 => Self::Dispatching,
            5 => Self::Responding,
            6 => Self::ProbingConstancy,
            7 => Self::Disconnected,
            _ => Self::HardReset,
        }
    }
}

/// Rule Maker events for the daemon protocol.
///
/// Callers never choose an arbitrary destination state. They submit
/// the observed protocol event, and the transition table below is the
/// single authority that decides the required predecessor and next
/// state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[doc(alias = "state-machine-event")]
#[doc(alias = "rule-maker-event")]
pub enum ConnectionEvent {
    /// A newly accepted socket is ready to read its first bounded frame.
    StartReading,
    /// A complete newline-delimited request frame was acquired.
    FrameComplete,
    /// Frame bytes were valid UTF-8.
    Utf8Decoded,
    /// UTF-8 text decoded into `WireRequestV1`.
    JsonDecoded,
    /// The decoded request completed the dispatch boundary.
    Dispatched,
    /// A response was serialized, written, and flushed.
    ResponseWritten,
    /// Heng constancy probing completed for the previous turn.
    ConstancyProbed,
    /// Peer closed cleanly while the FSM was awaiting a new frame.
    PeerClosed,
}

impl ConnectionEvent {
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::StartReading => "start_reading",
            Self::FrameComplete => "frame_complete",
            Self::Utf8Decoded => "utf8_decoded",
            Self::JsonDecoded => "json_decoded",
            Self::Dispatched => "dispatched",
            Self::ResponseWritten => "response_written",
            Self::ConstancyProbed => "constancy_probed",
            Self::PeerClosed => "peer_closed",
        }
    }

    #[must_use]
    const fn rule(self) -> (ConnectionState, ConnectionState) {
        match self {
            Self::StartReading => (ConnectionState::Accepted, ConnectionState::ReadingFrame),
            Self::FrameComplete => (ConnectionState::ReadingFrame, ConnectionState::DecodingUtf8),
            Self::Utf8Decoded => (ConnectionState::DecodingUtf8, ConnectionState::DecodingJson),
            Self::JsonDecoded => (ConnectionState::DecodingJson, ConnectionState::Dispatching),
            Self::Dispatched => (ConnectionState::Dispatching, ConnectionState::Responding),
            Self::ResponseWritten => (
                ConnectionState::Responding,
                ConnectionState::ProbingConstancy,
            ),
            Self::ConstancyProbed => (
                ConnectionState::ProbingConstancy,
                ConnectionState::ReadingFrame,
            ),
            Self::PeerClosed => (ConnectionState::ReadingFrame, ConnectionState::Disconnected),
        }
    }
}

/// Result of attempting an atomic FSM transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionOutcome {
    /// Transition followed the protocol contract.
    Advanced,
    /// Observed state did not match the event's Rule Maker predecessor;
    /// the FSM moved to `HardReset`.
    HardReset {
        event: ConnectionEvent,
        expected: ConnectionState,
        observed: ConnectionState,
        requested: ConnectionState,
    },
}

impl TransitionOutcome {
    #[cfg(test)]
    #[must_use]
    pub const fn is_hard_reset(self) -> bool {
        matches!(self, Self::HardReset { .. })
    }
}

/// Active post-turn constancy profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[doc(alias = "heng-initiative-logic")]
pub struct HengProfile {
    /// Read chunk cap to apply to the next turn. This value is always
    /// less than or equal to the hard frame policy chunk limit.
    pub read_chunk_bytes: usize,
    /// Current score in basis points. 10000 means full budget usage.
    pub pressure_basis_points: u64,
    /// Whether the previous turn crossed the critical 80% threshold.
    pub crossed_80pct: bool,
}

/// Atomic connection FSM.
///
/// All protocol transitions use `compare_exchange`, so concurrent
/// callers cannot create two valid branches. In practice one Tokio
/// task owns a connection; the atomic still documents and enforces
/// the invariant at the memory model level.
#[derive(Debug)]
#[doc(alias = "state-machine-pattern")]
#[doc(alias = "rule-maker-protocol")]
pub struct ConnectionFsm {
    state: AtomicU8,
    hard_resets: AtomicU64,
    heng_pressure_bp: AtomicU64,
}

impl ConnectionFsm {
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: AtomicU8::new(ConnectionState::Accepted.as_u8()),
            hard_resets: AtomicU64::new(0),
            heng_pressure_bp: AtomicU64::new(0),
        }
    }

    #[must_use]
    pub fn state(&self) -> ConnectionState {
        ConnectionState::from_u8(self.state.load(Ordering::Acquire))
    }

    #[must_use]
    #[cfg(test)]
    pub fn hard_reset_count(&self) -> u64 {
        self.hard_resets.load(Ordering::Relaxed)
    }

    /// Apply one Rule Maker event.
    ///
    /// Any mismatch means there is no longer one authoritative branch
    /// of truth. The state is forced to [`ConnectionState::HardReset`]
    /// and the caller should immediately close the connection.
    pub fn apply(&self, event: ConnectionEvent) -> TransitionOutcome {
        let (expected, next) = event.rule();
        match self.state.compare_exchange(
            expected.as_u8(),
            next.as_u8(),
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => TransitionOutcome::Advanced,
            Err(observed) => {
                let observed = ConnectionState::from_u8(observed);
                self.hard_reset("invalid_transition");
                TransitionOutcome::HardReset {
                    event,
                    expected,
                    observed,
                    requested: next,
                }
            }
        }
    }

    /// Force terminal reset for protocol deviations or transport
    /// faults.
    pub fn hard_reset(&self, _reason: &'static str) {
        self.hard_resets.fetch_add(1, Ordering::Relaxed);
        self.state
            .store(ConnectionState::HardReset.as_u8(), Ordering::Release);
    }

    /// Active Heng probe: derive the next turn's read profile from
    /// observed latency and frame pressure.
    ///
    /// This never raises hard protocol limits. It only selects a read
    /// chunk inside the hard cap so a pressured connection yields more
    /// often to the runtime, while a stable connection gets the fast
    /// path.
    ///
    /// # Project Decision Logic
    ///
    /// Pressure is measured in basis points to keep alert rules and tests
    /// integer-stable. The thresholds are intentionally asymmetric:
    ///
    /// - below 50% budget, an honest client keeps the full read chunk;
    /// - at 50%, the connection is no longer pathological, but it should yield
    ///   twice as often so other handler tasks keep progress;
    /// - at 80%, the peer is close enough to a hard cap that we emit telemetry
    ///   and quarter the next chunk.
    ///
    /// This mirrors the daemon's game-theory posture: reward cooperative
    /// behavior with the fast path, make boundary-probing behavior more
    /// expensive for the probing peer, and never silently lift the hard cap.
    #[doc(alias = "heng-pressure-thresholds")]
    #[doc(alias = "game-theory-network-thresholds")]
    #[must_use]
    pub fn probe_constancy(
        &self,
        latency: Duration,
        frame_bytes: usize,
        frame_limit: usize,
        hard_chunk_limit: usize,
    ) -> HengProfile {
        let frame_bp = utilization_basis_points(frame_bytes, frame_limit);
        let latency_bp = utilization_basis_points(latency.as_millis() as usize, 1_000);
        let pressure_basis_points = frame_bp.max(latency_bp).min(10_000);
        self.heng_pressure_bp
            .store(pressure_basis_points, Ordering::Relaxed);

        let divisor = if pressure_basis_points >= 8_000 {
            4
        } else if pressure_basis_points >= 5_000 {
            2
        } else {
            1
        };
        let read_chunk_bytes = hard_chunk_limit.saturating_div(divisor).max(1);

        HengProfile {
            read_chunk_bytes,
            pressure_basis_points,
            crossed_80pct: pressure_basis_points >= 8_000,
        }
    }
}

impl Default for ConnectionFsm {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn valid_daemon_turn_returns_to_reading_frame() {
        let fsm = ConnectionFsm::new();
        assert_eq!(
            fsm.apply(ConnectionEvent::StartReading),
            TransitionOutcome::Advanced
        );
        assert_eq!(
            fsm.apply(ConnectionEvent::FrameComplete),
            TransitionOutcome::Advanced
        );
        assert_eq!(
            fsm.apply(ConnectionEvent::Utf8Decoded),
            TransitionOutcome::Advanced
        );
        assert_eq!(
            fsm.apply(ConnectionEvent::JsonDecoded),
            TransitionOutcome::Advanced
        );
        assert_eq!(
            fsm.apply(ConnectionEvent::Dispatched),
            TransitionOutcome::Advanced
        );
        assert_eq!(
            fsm.apply(ConnectionEvent::ResponseWritten),
            TransitionOutcome::Advanced
        );
        assert_eq!(
            fsm.apply(ConnectionEvent::ConstancyProbed),
            TransitionOutcome::Advanced
        );
        assert_eq!(fsm.state(), ConnectionState::ReadingFrame);
    }

    #[test]
    fn unexpected_event_forces_hard_reset() {
        let fsm = ConnectionFsm::new();
        let outcome = fsm.apply(ConnectionEvent::Dispatched);

        assert!(outcome.is_hard_reset());
        assert_eq!(fsm.state(), ConnectionState::HardReset);
        assert_eq!(fsm.hard_reset_count(), 1);
    }

    #[test]
    fn peer_closed_is_only_valid_while_reading() {
        let fsm = ConnectionFsm::new();

        assert!(fsm.apply(ConnectionEvent::PeerClosed).is_hard_reset());
        assert_eq!(fsm.state(), ConnectionState::HardReset);
    }

    #[test]
    fn heng_probe_reduces_chunk_under_pressure() {
        let fsm = ConnectionFsm::new();

        let calm = fsm.probe_constancy(Duration::from_millis(10), 100, 10_000, 8_192);
        assert_eq!(calm.read_chunk_bytes, 8_192);
        assert!(!calm.crossed_80pct);

        let pressured = fsm.probe_constancy(Duration::from_millis(900), 9_000, 10_000, 8_192);
        assert_eq!(pressured.read_chunk_bytes, 2_048);
        assert!(pressured.crossed_80pct);
    }
}
