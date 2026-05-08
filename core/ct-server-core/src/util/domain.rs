// SPDX-License-Identifier: AGPL-3.0-only
//! Cycle 3 / v0.0.55 — Single source of truth for the panel hostname.
//!
//! The "panel hostname" (`panel.<base>` per the v0.0.33 SNI router
//! design) was hardcoded in at least 6 places across panel/ and core/
//! before Cycle 3, with each callsite re-implementing the
//! `PANEL_DOMAIN`-or-fallback-to-`panel.<DOMAIN>` derivation. v0.0.51,
//! v0.0.53, and v0.0.54 each fixed one site; this module collapses
//! the derivation into a single function that all in-tree Rust
//! callers (haproxy renderer, caddy renderer, CLI helpers) and PHP
//! callers (via panel/config/cool-tunnel.php::panel_domain, mirrored
//! shape) read from.
//!
//! Cross-language symmetry: the PHP fallback in
//! panel/config/cool-tunnel.php uses identical logic. CI guard
//! scripts/verify_sot.sh runs both and asserts byte-equality on
//! fixture envs.
//!
//! Fail-fast on empty env (per the operator directive): if both
//! PANEL_DOMAIN and DOMAIN are unset/empty, return an error rather
//! than silently producing "panel." (which would route to nothing
//! and surface as a render-time fail).

use crate::{Error, Result};

/// Resolve the panel hostname from the two env vars that drive it.
///
/// Pure function — takes the two strings and returns the resolved
/// value or an error. The wrapper [`panel_domain`] reads them from
/// `std::env`. Splitting them lets unit tests exercise the logic
/// without mutating process-global env (which would interleave with
/// other tests and the integration-test harness).
pub fn panel_domain_from(panel_domain_env: &str, domain_env: &str) -> Result<String> {
    let pd = panel_domain_env.trim();
    if !pd.is_empty() {
        return Ok(pd.to_owned());
    }
    let d = domain_env.trim();
    if d.is_empty() {
        return Err(Error::msg(
            "Both PANEL_DOMAIN and DOMAIN are unset/empty in the process environment. \
             At least one must be set. PANEL_DOMAIN takes priority; if unset, the \
             panel hostname is derived as `panel.<DOMAIN>`. See .env.example. \
             (Cycle 3 / v0.0.55 — fail-fast rather than silently produce 'panel.' \
             with an empty base, which would produce a malformed URL.)",
        ));
    }
    Ok(format!("panel.{d}"))
}

/// Read the two env vars and resolve. Used by every Rust callsite
/// that needs the panel hostname — CLI subcommands, the haproxy
/// renderer's caller, the caddy renderer's caller.
pub fn panel_domain() -> Result<String> {
    panel_domain_from(
        std::env::var("PANEL_DOMAIN").unwrap_or_default().as_str(),
        std::env::var("DOMAIN").unwrap_or_default().as_str(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_panel_domain_takes_priority() {
        // Operator-set PANEL_DOMAIN (the v0.0.33+ canonical .env shape)
        // wins over any DOMAIN-based derivation, including a non-empty
        // DOMAIN that would otherwise produce a different fallback.
        let r = panel_domain_from("admin.example.com", "example.com");
        assert_eq!(r.unwrap_or_default(), "admin.example.com");
    }

    #[test]
    fn empty_panel_domain_falls_back_to_derived() {
        // Pre-v0.0.33 .env shape (DOMAIN only, PANEL_DOMAIN missing
        // or empty). v0.0.54's auto-heal in update.sh fixes this at
        // make-update time, but the resolver still has to handle
        // this state for a fresh `cargo run` against a partially-
        // migrated env.
        let r = panel_domain_from("", "example.com");
        assert_eq!(r.unwrap_or_default(), "panel.example.com");
    }

    #[test]
    fn whitespace_panel_domain_treated_as_empty() {
        // Defensive: `PANEL_DOMAIN=    ` (operator set with stray
        // whitespace) is treated as unset rather than as a literal
        // blank-string hostname. trim()-then-empty-check on both
        // inputs. PHP-side mirrors this discipline.
        let r = panel_domain_from("   \n\t", "example.com");
        assert_eq!(r.unwrap_or_default(), "panel.example.com");
    }

    #[test]
    fn empty_domain_with_explicit_panel_domain_works() {
        // PANEL_DOMAIN takes priority, so a missing DOMAIN is fine
        // as long as PANEL_DOMAIN is set. Some operators might omit
        // DOMAIN entirely in unusual deployment topologies (panel-
        // only, no proxy traffic).
        let r = panel_domain_from("admin.example.com", "");
        assert_eq!(r.unwrap_or_default(), "admin.example.com");
    }

    #[test]
    fn both_empty_fails_fast() {
        // The fail-fast contract per the Cycle 3 operator directive:
        // never silently produce "panel." (with an empty base) — that
        // would route to a malformed URL and surface as a runtime
        // render failure or a 0-byte hostname in haproxy.cfg. Loud
        // error at resolve time is the right operator-feedback shape.
        // Match-on-Result rather than `unwrap_err()` to keep the
        // workspace's `clippy::unwrap_used = deny` lint happy.
        let msg = match panel_domain_from("", "") {
            Ok(s) => format!("expected Err, got Ok({s})"),
            Err(e) => format!("{e:?}"),
        };
        assert!(
            msg.contains("PANEL_DOMAIN") && msg.contains("DOMAIN"),
            "error message must name both env vars: {msg}"
        );
    }

    #[test]
    fn whitespace_in_panel_domain_is_trimmed() {
        // Operator who copy-pasted with trailing newline / spaces
        // gets the trimmed value, not the literal. Same trim
        // semantics as the empty-detection path.
        let r = panel_domain_from("  admin.example.com  \n", "example.com");
        assert_eq!(r.unwrap_or_default(), "admin.example.com");
    }
}
