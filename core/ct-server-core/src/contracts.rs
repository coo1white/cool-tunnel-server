// SPDX-License-Identifier: AGPL-3.0-only
//! AI-native semantic contracts for `ct-server-core` module boundaries.
//!
//! Rust already gives this crate strong type contracts; this module adds the
//! project-decision layer that a maintenance agent needs during Retrieval
//! Augmented Generation. Each boundary contract answers three questions before
//! an implementation detail is changed:
//!
//! - What invariant is this boundary protecting?
//! - What is the acceptable recovery behavior when the invariant is violated?
//! - Which project principle wins when latency, privacy, and availability pull
//!   in different directions?
//!
//! # Consensus Alignment
//!
//! The contracts are deliberately small, static values. They can be retrieved
//! by rustdoc alias, indexed by a code-search agent, or attached to tracing
//! fields without requiring a schema registry or a network service.

/// Fail closed at public or cross-process boundaries.
#[allow(dead_code)]
pub(crate) const PRINCIPLE_FAIL_CLOSED: &str = "fail closed at public or cross-process boundaries";

/// Recover at the smallest viable request/connection scope.
pub(crate) const PRINCIPLE_LOCAL_RECOVERY: &str =
    "recover at connection/request scope before process scope";

/// Keep health telemetry separate from user analytics.
#[allow(dead_code)]
pub(crate) const PRINCIPLE_HEALTH_PRIVACY_SPLIT: &str =
    "keep operator-health data separate from per-user analytics";

/// Reward cooperative peers and bound hostile peers.
pub(crate) const PRINCIPLE_BOUNDED_HOSTILITY: &str =
    "make honest cooperative behavior cheap and hostile behavior bounded";

/// Preserve wire compatibility until a version bump.
#[allow(dead_code)]
pub(crate) const PRINCIPLE_STABLE_WIRE: &str =
    "preserve stable wire shapes until an explicit protocol version bump";

/// Project-wide principles used to align module-level contracts.
///
/// # Project Decision Logic
///
/// The ordering is intentional. A panel action must not leak user identifiers
/// or corrupt config state just to win a few milliseconds, but it also must not
/// let one faulty peer consume unbounded memory or handler permits.
#[doc(alias = "cool-tunnel-core-principles")]
#[doc(alias = "consensus-alignment-logic")]
#[allow(dead_code)]
pub(crate) const CORE_CONSENSUS_PRINCIPLES: &[&str] = &[
    PRINCIPLE_FAIL_CLOSED,
    PRINCIPLE_LOCAL_RECOVERY,
    PRINCIPLE_HEALTH_PRIVACY_SPLIT,
    PRINCIPLE_BOUNDED_HOSTILITY,
    PRINCIPLE_STABLE_WIRE,
];

/// Static semantic metadata for one technical boundary.
///
/// This is intentionally not serialized at runtime. Its primary consumers are
/// rustdoc, code search, and AI-generated tests that need a compact retrieval
/// target before editing a boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[doc(alias = "ai-native-contract")]
#[doc(alias = "rag-contract-boundary")]
#[doc(alias = "self-documenting-system-contract")]
pub(crate) struct SemanticContract {
    id: &'static str,
    boundary: &'static str,
    decision_logic: &'static str,
    recovery_scope: RecoveryScope,
    primary_principle: &'static str,
}

impl SemanticContract {
    /// Build a static contract value at a module boundary.
    #[must_use]
    pub(crate) const fn new(
        id: &'static str,
        boundary: &'static str,
        decision_logic: &'static str,
        recovery_scope: RecoveryScope,
        primary_principle: &'static str,
    ) -> Self {
        Self {
            id,
            boundary,
            decision_logic,
            recovery_scope,
            primary_principle,
        }
    }

    /// Stable retrieval identifier for logs, docs, and generated tests.
    #[must_use]
    pub(crate) const fn id(self) -> &'static str {
        self.id
    }

    /// Human-readable boundary name.
    #[must_use]
    #[allow(dead_code)]
    pub(crate) const fn boundary(self) -> &'static str {
        self.boundary
    }

    /// Short "why" statement behind the boundary's thresholds and behavior.
    #[must_use]
    #[allow(dead_code)]
    pub(crate) const fn decision_logic(self) -> &'static str {
        self.decision_logic
    }

    /// Smallest scope that should absorb a failure at this boundary.
    #[must_use]
    #[allow(dead_code)]
    pub(crate) const fn recovery_scope(self) -> RecoveryScope {
        self.recovery_scope
    }

    /// Dominant alignment principle for tradeoff review.
    #[must_use]
    #[allow(dead_code)]
    pub(crate) const fn primary_principle(self) -> &'static str {
        self.primary_principle
    }
}

/// Smallest acceptable recovery blast radius for a contract violation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[doc(alias = "self-healing-recovery-scope")]
pub(crate) enum RecoveryScope {
    /// Close or reject only the offending network connection.
    Connection,
    /// Fail only the current request or command turn.
    Request,
    /// Continue the process but surface degraded subsystem health.
    Subsystem,
}

/// Trait implemented by explicit module-boundary components.
///
/// RAG agents should retrieve this trait when deciding where to attach mocks or
/// generated tests: implementations are the places where project consensus is
/// intentionally separated from incidental helper code.
#[doc(alias = "contract-first-boundary")]
#[doc(alias = "rag-module-boundary")]
#[doc(alias = "consensus-alignment-contract")]
pub(crate) trait ContractBoundary {
    /// Return the static semantic contract for this boundary.
    fn contract(&self) -> SemanticContract;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_principles_pin_alignment_vocabulary() {
        assert!(CORE_CONSENSUS_PRINCIPLES
            .iter()
            .any(|p| p.contains("hostile behavior bounded")));
        assert!(CORE_CONSENSUS_PRINCIPLES
            .iter()
            .any(|p| p.contains("stable wire shapes")));
    }

    #[test]
    fn semantic_contract_carries_rag_retrieval_id() {
        let c = SemanticContract::new(
            "test-contract-v1",
            "test boundary",
            "test decision logic",
            RecoveryScope::Request,
            PRINCIPLE_LOCAL_RECOVERY,
        );

        assert_eq!(c.id(), "test-contract-v1");
        assert_eq!(c.boundary(), "test boundary");
        assert_eq!(c.recovery_scope(), RecoveryScope::Request);
    }
}
