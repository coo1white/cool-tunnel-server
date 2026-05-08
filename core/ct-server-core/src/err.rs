// SPDX-License-Identifier: AGPL-3.0-only
//! Single error type so we don't pull `anyhow` (heavier than we need).
//!
//! Shape: opaque tuple wrapper around `Box<dyn Error + Send + Sync>`.
//! Deliberately not an enum — the v0.0.65 hardening pass evaluated
//! rewriting this as a `#[non_exhaustive] enum` with per-variant
//! `#[source]` derives (the "thiserror shape"). Verdict: not yet
//! worth the churn. No call site in this crate matches on inner
//! type; every consumer uses `?` or `e.to_string()`. The opaque
//! wrapper preserves the `source()` chain (verified by
//! `format_error_chain` in `main.rs` walking up to depth 16) and
//! keeps the type surface small. Revisit if a caller surfaces a
//! real need to discriminate by inner type — at that point a
//! `Kind` accessor or full enum rewrite are both on the table.
//!
//! We can't write a blanket `impl<E: Error> From<E> for Error` — that
//! conflicts with std's reflexive `impl<T> From<T> for T`. Instead we
//! explicitly enumerate the error types we actually wrap. The list
//! reads like a dependency map of the crate, which is fine: the
//! compiler tells us when to add a new line.

use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

/// The crate's unified error type.
///
/// The inner field is `pub(crate)` rather than `pub` (E-1, v0.0.65)
/// — the previous `pub` made the boxed inner type part of the public
/// API surface, so any future change to the internal repr (adding a
/// `Kind` tag, switching `Box` for `Arc`, etc.) would have been a
/// breaking change for downstream code matching `Error(boxed)`.
/// Read access is via [`Error::inner`].
#[derive(Debug)]
pub struct Error(pub(crate) Box<dyn std::error::Error + Send + Sync>);

impl Error {
    /// Construct an error from a free-form message.
    ///
    /// `#[track_caller]` (E-2, v0.0.65) captures the call-site
    /// `file:line` and appends it to the message body so operators
    /// reading `error: ...` lines see *where* the error was raised
    /// in addition to *what* went wrong. Pre-v0.0.65 the operator
    /// had to grep the source for the message string to locate the
    /// site; the appended location turns the chain into an
    /// actionable pointer.
    #[track_caller]
    pub fn msg<S: Into<String>>(s: S) -> Self {
        let loc = std::panic::Location::caller();
        let body = format!("{} (at {}:{})", s.into(), loc.file(), loc.line());
        Self(Box::new(StringError(body)))
    }

    /// Wrap a `source` error with a custom operator-facing message.
    /// Both surface in the source-chain walk: the outer message via
    /// `Display`, the source via `source()`. (E-3, v0.0.65.)
    ///
    /// Use when you want to preserve a specific underlying error
    /// (e.g. a `tokio::io::Error` from `fs::write`) but supply a
    /// more actionable operator-facing description than the raw
    /// io error message would carry on its own. Pre-v0.0.65 the
    /// only way to get this shape was to declare a private wrapper
    /// struct per call site (the `NestedErr` pattern in
    /// `main_tests` was that escape hatch); now it's a one-liner.
    ///
    /// Like [`Error::msg`], the constructor is `#[track_caller]` so
    /// the appended `file:line` points at the wrapping site, not at
    /// `err.rs`.
    #[track_caller]
    #[allow(dead_code)] // first uses land in v0.0.65+; constructor is the API
    pub fn context<S, E>(msg: S, source: E) -> Self
    where
        S: Into<String>,
        E: std::error::Error + Send + Sync + 'static,
    {
        let loc = std::panic::Location::caller();
        let body = format!("{} (at {}:{})", msg.into(), loc.file(), loc.line());
        Self(Box::new(ContextError {
            msg: body,
            src: Box::new(source),
        }))
    }

    /// Read access to the boxed inner error. Lets callers walk the
    /// `source()` chain themselves without grabbing the boxed
    /// pointer directly. (E-1, v0.0.65 — pairs with the
    /// `pub(crate)` tightening of the inner field.)
    #[allow(dead_code)] // primarily for downstream consumers; main walks via source() directly
    pub fn inner(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
        &*self.0
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&*self.0)
    }
}

#[derive(Debug)]
struct StringError(String);
impl fmt::Display for StringError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for StringError {}

/// Carrier for [`Error::context`] — pairs an operator-facing message
/// with a preserved `source()` chain.
#[derive(Debug)]
struct ContextError {
    msg: String,
    src: Box<dyn std::error::Error + Send + Sync>,
}
impl fmt::Display for ContextError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}
impl std::error::Error for ContextError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&*self.src)
    }
}

// Explicit From impls per dependency. Adding a new dep means adding a
// new line here, which is on purpose — keeps the error surface visible
// at a glance.
macro_rules! from_impl {
    ($($t:ty),+ $(,)?) => {
        $(
            impl From<$t> for Error {
                fn from(e: $t) -> Self { Self(Box::new(e)) }
            }
        )+
    };
}

from_impl! {
    std::io::Error,
    std::str::Utf8Error,
    std::string::FromUtf8Error,
    std::num::ParseIntError,
    serde_json::Error,
    sqlx::Error,
    // hyper / hyper-util / hyperlocal / http-body-util were the
    // old unix-domain admin path's stack. Dropped from Cargo.toml in
    // the 2026-05-05 low-mem-server pass — reqwest is now the only
    // HTTP client the binary exercises. Adding them back means
    // re-listing them in Cargo.toml AND restoring the From impls.
    reqwest::Error,
    redis::RedisError,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::error::Error as _;

    #[test]
    fn error_msg_carries_call_site_in_display() {
        // E-2: `#[track_caller]` plus the body-format means the
        // operator sees where the error was raised. The exact
        // line number is brittle (any edit above this `let`
        // shifts it), so we assert presence rather than equality.
        let e = Error::msg("disk full");
        let s = e.to_string();
        assert!(s.contains("disk full"), "outer message preserved: {s:?}");
        assert!(
            s.contains("err.rs:"),
            "call-site file:line appended (file in path required): {s:?}",
        );
    }

    #[test]
    fn error_context_preserves_source_chain() {
        // E-3: `Error::context(msg, source)` pairs an operator-facing
        // message with a preserved underlying error. Walk source()
        // and check both halves surface.
        let inner = std::io::Error::other("connection refused");
        let outer = Error::context("could not load clash secret", inner);

        let outer_msg = outer.to_string();
        assert!(
            outer_msg.contains("could not load clash secret"),
            "outer message present: {outer_msg:?}",
        );
        assert!(
            outer_msg.contains("err.rs:"),
            "call-site appended to outer: {outer_msg:?}",
        );

        // Walk: outer Error → ContextError (via Error::source) →
        // io::Error (via ContextError::source).
        let src1 = outer.source().expect("Error wrapper has source");
        let src2 = src1.source().expect("ContextError has source");
        let src2_msg = src2.to_string();
        assert!(
            src2_msg.contains("connection refused"),
            "io error preserved at depth 2: {src2_msg:?}",
        );
    }

    #[test]
    fn error_inner_returns_boxed_dyn() {
        // E-1: inner() gives read access without exposing the Box
        // type publicly. Smoke check: it returns the same Display
        // text as the outer Error.
        let e: Error = std::io::Error::other("file not found").into();
        assert_eq!(e.to_string(), e.inner().to_string());
    }
}
