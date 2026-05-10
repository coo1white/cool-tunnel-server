// SPDX-License-Identifier: AGPL-3.0-only
//! OTel-compatible observability helpers for the Rust core.
//!
//! The project intentionally keeps exporters out of the hot binary:
//! traces are emitted through `tracing` spans with OpenTelemetry
//! semantic attribute names, while metrics are exposed through the
//! existing Prometheus-compatible internal endpoint. An external OTel
//! Collector can scrape `/metrics` and ingest stderr logs without this
//! crate pulling in a large exporter stack.

use bytes::BytesMut;
use std::fmt;
use std::time::Duration;

/// OTel semantic convention keys used by the hand-rolled network
/// spans. Centralizing these strings prevents drift between daemon
/// and metrics instrumentation.
pub mod otel_key {
    pub const NETWORK_TRANSPORT: &str = "network.transport";
    pub const NETWORK_PROTOCOL_NAME: &str = "network.protocol.name";
    pub const RPC_SYSTEM: &str = "rpc.system";
    pub const RPC_METHOD: &str = "rpc.method";
    pub const HTTP_REQUEST_METHOD: &str = "http.request.method";
    pub const URL_PATH: &str = "url.path";
    pub const ERROR_TYPE: &str = "error.type";
    pub const CT_FRAME_POLICY: &str = "ct.frame.policy";
    pub const CT_BUFFER_BYTES: &str = "ct.buffer.bytes";
    pub const CT_BUFFER_LIMIT_BYTES: &str = "ct.buffer.limit_bytes";
    pub const CT_STATUS_CODE: &str = "ct.status_code";
}

/// Offense-driven alert threshold in basis points. Crossing 80%
/// means a hostile or pathological client is close enough to a hard
/// limit that the next turn should emit forensic detail instead of
/// staying silent.
pub const BOTTLENECK_ALERT_BASIS_POINTS: u64 = 8_000;

/// Latency budget used for the 80% threshold on daemon wire turns.
/// The panel path is intentionally expected to be snappy; reloads
/// can take longer, but crossing this mark means the operator should
/// start looking before users feel hard failure.
pub const DAEMON_TURN_LATENCY_BUDGET: Duration = Duration::from_millis(500);

/// Latency budget used for the 80% threshold on internal metrics
/// scrapes. A local Prometheus scrape should complete well inside
/// this unless the process is CPU-starved or blocked behind I/O.
pub const METRICS_TURN_LATENCY_BUDGET: Duration = Duration::from_millis(100);

/// Convert used/limit into basis points to avoid floating point in
/// Prometheus output and alert rules.
#[must_use]
pub fn utilization_basis_points(used: usize, limit: usize) -> u64 {
    if limit == 0 {
        return 0;
    }
    ((used as u128).saturating_mul(10_000) / (limit as u128)) as u64
}

#[must_use]
pub fn crosses_80pct_threshold(used: usize, limit: usize) -> bool {
    utilization_basis_points(used, limit) >= BOTTLENECK_ALERT_BASIS_POINTS
}

#[must_use]
pub fn duration_utilization_basis_points(duration: Duration, budget: Duration) -> u64 {
    let budget_nanos = budget.as_nanos();
    if budget_nanos == 0 {
        return 0;
    }
    let used_nanos = duration.as_nanos();
    ((used_nanos).saturating_mul(10_000) / budget_nanos) as u64
}

#[must_use]
pub fn duration_crosses_80pct_threshold(duration: Duration, budget: Duration) -> bool {
    duration_utilization_basis_points(duration, budget) >= BOTTLENECK_ALERT_BASIS_POINTS
}

#[must_use]
pub fn duration_ms_u64(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// Redacted byte dump for critical network-boundary failures.
///
/// The dump is capped so a hostile client cannot make the diagnostic
/// path allocate unboundedly. It is intended only for warn/error logs
/// emitted after a threshold or parser failure, never for normal
/// successful turns.
pub struct HexDump<'a> {
    bytes: &'a [u8],
    max: usize,
}

impl<'a> HexDump<'a> {
    #[must_use]
    pub fn new(bytes: &'a [u8], max: usize) -> Self {
        Self { bytes, max }
    }
}

impl fmt::Display for HexDump<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let shown = self.bytes.len().min(self.max);
        for (idx, b) in self.bytes.iter().take(shown).enumerate() {
            if idx > 0 {
                f.write_str(" ")?;
            }
            write!(f, "{b:02x}")?;
        }
        if self.bytes.len() > shown {
            write!(f, " ...(+{} bytes)", self.bytes.len() - shown)?;
        }
        Ok(())
    }
}

/// Snapshot one line/header prefix without allocating large buffers.
#[must_use]
pub fn packet_header_dump(bytes: &BytesMut) -> HexDump<'_> {
    HexDump::new(bytes.as_ref(), 96)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn threshold_uses_80_percent_boundary() {
        assert!(!crosses_80pct_threshold(79, 100));
        assert!(crosses_80pct_threshold(80, 100));
    }

    #[test]
    fn duration_threshold_uses_80_percent_boundary() {
        assert!(!duration_crosses_80pct_threshold(
            Duration::from_millis(79),
            Duration::from_millis(100),
        ));
        assert!(duration_crosses_80pct_threshold(
            Duration::from_millis(80),
            Duration::from_millis(100),
        ));
    }

    #[test]
    fn hexdump_is_capped() {
        let bytes: Vec<u8> = (0_u8..8).collect();
        let dump = HexDump::new(&bytes, 4).to_string();
        assert_eq!(dump, "00 01 02 03 ...(+4 bytes)");
    }
}
