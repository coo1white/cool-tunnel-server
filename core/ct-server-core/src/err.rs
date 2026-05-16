// SPDX-License-Identifier: AGPL-3.0-only
//! Strict error taxonomy for `ct-server-core`.
//!
//! The server boundary does not traffic in opaque boxed errors:
//! every failure is represented by an enum variant with a stable
//! category. Callers can fail fast on corrupt input, dependency
//! failure, or operator misconfiguration without panicking, and
//! daemon-mode handlers can translate those same variants into
//! deterministic wire error codes.
//!
//! # AI-Native Maintenance Contract
//!
//! This module is the repair-agent entrypoint for failure semantics.
//! Do not add an error variant without documenting:
//!
//! - the boundary where it can originate,
//! - whether the caller should retry, close one connection, or abort
//!   the current command,
//! - the stable wire code exposed to daemon clients.

use std::fmt;
use std::time::Duration;

pub type Result<T> = std::result::Result<T, Error>;

/// Crate-wide error type.
///
/// The variants are grouped by the layer that can recover from them:
/// network-frame errors close only the offending connection,
/// dependency errors bubble to the CLI/daemon handler, and
/// configuration/rendering errors stop the current operation before a
/// partial config can be loaded.
#[derive(Debug)]
#[doc(alias = "rag-error-taxonomy")]
#[doc(alias = "self-healing-error-contract")]
#[doc(alias = "contract-first-errors")]
pub enum Error {
    /// Generic filesystem or socket I/O failure. Prefer
    /// [`Error::io_path`] at call sites that know the operation/path.
    Io {
        op: &'static str,
        path: Option<String>,
        source: std::io::Error,
    },
    /// UTF-8 validation failed on bytes received from a boundary.
    Utf8(std::str::Utf8Error),
    /// Owned byte buffer could not be converted to UTF-8.
    FromUtf8(std::string::FromUtf8Error),
    /// Integer parsing failed.
    ParseInt(std::num::ParseIntError),
    /// JSON parse or serialization failure.
    Json(serde_json::Error),
    /// MariaDB / SQLx failure.
    Sql(sqlx::Error),
    /// HTTP client failure.
    Http(reqwest::Error),
    /// Redis client/subscriber failure.
    Redis(redis::RedisError),
    /// Template syntax or binding failure.
    Template(crate::template::RenderError),
    // v0.4.0 — `Crypt` variant removed alongside the laravel_crypt
    // module. APP_KEY-bearing decrypts moved to the panel layer
    // (Laravel's `encrypted` cast on ServerConfig.reality_private_key);
    // ct-server-core no longer touches the encrypted-at-rest column.
    /// Operator-controlled configuration is missing or invalid.
    Config { message: String },
    /// Input failed a domain-specific validator.
    Validation {
        component: &'static str,
        message: String,
    },
    /// Template file could not be read.
    TemplateRead {
        path: String,
        source: std::io::Error,
    },
    /// Template file could not be rendered.
    TemplateRender {
        path: String,
        source: crate::template::RenderError,
    },
    /// Output path has no parent directory.
    MissingParent { path: String },
    /// Atomic file write step failed.
    AtomicWrite {
        path: String,
        op: &'static str,
        source: std::io::Error,
    },
    /// External process did not finish within the hard timeout.
    ExternalCommandTimedOut {
        command: &'static str,
        timeout: Duration,
        hint: String,
    },
    /// External process completed with a non-zero status.
    ExternalCommandFailed {
        command: &'static str,
        stderr: String,
    },
    /// External process could not be spawned.
    ProcessSpawn {
        program: &'static str,
        source: std::io::Error,
    },
    /// External process exited during readiness checks.
    ProcessExitedEarly {
        program: &'static str,
        code: Option<i32>,
        address: String,
    },
    /// External process did not expose its local listener in time.
    ProcessStartTimeout {
        program: &'static str,
        address: String,
        timeout: Duration,
    },
    /// sing-box clash API returned an HTTP error.
    ClashApiStatus {
        endpoint: &'static str,
        status: reqwest::StatusCode,
        body: String,
    },
    /// sing-box clash API request failed before a usable response.
    ClashApi { op: &'static str, message: String },
    /// Request frame exceeded the configured byte limit.
    FrameTooLarge { limit: usize },
    /// Peer closed before a complete request frame was received.
    FrameIncomplete,
    /// Peer did not send a complete request within the configured
    /// timeout.
    ReadTimeout { timeout: Duration },
    /// Boundary input was syntactically invalid.
    BadRequest { code: &'static str, message: String },
    /// The request is known but intentionally unsupported on this
    /// transport.
    UnsupportedOperation {
        operation: &'static str,
        message: &'static str,
    },
    /// Tokio semaphore was closed while the listener needed a permit.
    SemaphoreClosed { resource: &'static str },
    /// A detached Tokio task panicked or was cancelled.
    TaskJoin {
        task: &'static str,
        source: tokio::task::JoinError,
    },
    /// Requested DB object does not exist.
    NotFound { resource: &'static str, id: String },
    /// Probe/check helpers use string-returning lower-level
    /// classifiers; this variant keeps those failures typed at the
    /// crate boundary.
    Probe { message: String },
}

impl Error {
    pub fn io_path(op: &'static str, path: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            op,
            path: Some(path.into()),
            source,
        }
    }

    pub fn config(message: impl Into<String>) -> Self {
        Self::Config {
            message: message.into(),
        }
    }

    pub fn validation(component: &'static str, message: impl Into<String>) -> Self {
        Self::Validation {
            component,
            message: message.into(),
        }
    }

    pub fn clash(op: &'static str, message: impl Into<String>) -> Self {
        Self::ClashApi {
            op,
            message: message.into(),
        }
    }

    pub fn probe(message: impl Into<String>) -> Self {
        Self::Probe {
            message: message.into(),
        }
    }

    /// Stable machine code for daemon wire responses.
    ///
    /// # Project Decision Logic
    ///
    /// The daemon's self-healing behavior depends on clients seeing
    /// a deterministic class of failure instead of scraping
    /// operator-facing prose. This code is the consensus boundary
    /// between Rust internals and panel automation:
    ///
    /// - frame/input errors are client-scoped and should not restart
    ///   the daemon;
    /// - configuration and dependency errors fail the current
    ///   operation and invite operator repair;
    /// - semaphore/backpressure errors are internal health signals.
    ///
    /// When adding an [`Error`] variant, update this mapping and add a
    /// unit test that pins the wire code.
    #[must_use]
    #[doc(alias = "rag-wire-error-code")]
    #[doc(alias = "daemon-error-contract")]
    pub fn wire_code(&self) -> &'static str {
        match self {
            Self::Utf8(_) | Self::Json(_) | Self::BadRequest { .. } => "bad_request",
            Self::FrameTooLarge { .. } => "request_too_large",
            Self::FrameIncomplete => "incomplete_request",
            Self::ReadTimeout { .. } => "read_timeout",
            Self::UnsupportedOperation { .. } => "unsupported_operation",
            Self::NotFound { .. } => "not_found",
            Self::Config { .. }
            | Self::Validation { .. }
            | Self::Template(_)
            | Self::TemplateRead { .. }
            | Self::TemplateRender { .. }
            | Self::MissingParent { .. } => "configuration_error",
            Self::Sql(_) => "database_error",
            Self::Http(_) | Self::ClashApi { .. } | Self::ClashApiStatus { .. } => {
                "upstream_http_error"
            }
            Self::Redis(_) => "redis_error",
            Self::ExternalCommandTimedOut { .. }
            | Self::ExternalCommandFailed { .. }
            | Self::ProcessSpawn { .. }
            | Self::ProcessExitedEarly { .. }
            | Self::ProcessStartTimeout { .. } => "process_error",
            Self::SemaphoreClosed { .. } => "internal_backpressure_error",
            Self::TaskJoin { .. } => "internal_task_error",
            Self::Io { .. } | Self::FromUtf8(_) | Self::ParseInt(_) | Self::AtomicWrite { .. } => {
                "io_error"
            }
            Self::Probe { .. } => "probe_error",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { op, path, source } => match path {
                Some(path) => write!(f, "{op} `{path}` failed: {source}"),
                None => write!(f, "{op} failed: {source}"),
            },
            Self::Utf8(e) => write!(f, "invalid UTF-8 input: {e}"),
            Self::FromUtf8(e) => write!(f, "invalid UTF-8 buffer: {e}"),
            Self::ParseInt(e) => write!(f, "integer parse failed: {e}"),
            Self::Json(e) => write!(f, "JSON error: {e}"),
            Self::Sql(e) => write!(f, "database error: {e}"),
            Self::Http(e) => write!(f, "HTTP client error: {e}"),
            Self::Redis(e) => write!(f, "Redis error: {e}"),
            Self::Template(e) => write!(f, "template error: {e}"),
            Self::Config { message } => f.write_str(message),
            Self::Validation { component, message } => {
                write!(f, "{component} validation failed: {message}")
            }
            Self::TemplateRead { path, source } => {
                write!(f, "could not read template `{path}`: {source}")
            }
            Self::TemplateRender { path, source } => {
                write!(f, "could not render template `{path}`: {source}")
            }
            Self::MissingParent { path } => {
                write!(f, "output path `{path}` has no parent directory")
            }
            Self::AtomicWrite { path, op, source } => {
                write!(f, "atomic write `{path}` failed during {op}: {source}")
            }
            Self::ExternalCommandTimedOut {
                command,
                timeout,
                hint,
            } => write!(
                f,
                "`{command}` timed out after {}s. {hint}",
                timeout.as_secs()
            ),
            Self::ExternalCommandFailed { command, stderr } => {
                write!(f, "`{command}` failed: {stderr}")
            }
            Self::ProcessSpawn { program, source } => {
                write!(f, "could not spawn `{program}`: {source}")
            }
            Self::ProcessExitedEarly {
                program,
                code,
                address,
            } => write!(
                f,
                "`{program}` exited before binding {address} (status={code:?})"
            ),
            Self::ProcessStartTimeout {
                program,
                address,
                timeout,
            } => write!(f, "`{program}` did not bind {address} within {timeout:?}"),
            Self::ClashApiStatus {
                endpoint,
                status,
                body,
            } => write!(f, "sing-box clash {endpoint} failed: {status} - {body}"),
            Self::ClashApi { op, message } => write!(f, "sing-box clash {op}: {message}"),
            Self::FrameTooLarge { limit } => {
                write!(f, "request frame exceeds {limit} bytes")
            }
            Self::FrameIncomplete => f.write_str("connection closed with an incomplete frame"),
            Self::ReadTimeout { timeout } => {
                write!(
                    f,
                    "no complete request within {} seconds",
                    timeout.as_secs()
                )
            }
            Self::BadRequest { message, .. } => write!(f, "bad request: {message}"),
            Self::UnsupportedOperation { operation, message } => {
                write!(f, "{operation} is unsupported here: {message}")
            }
            Self::SemaphoreClosed { resource } => {
                write!(f, "{resource} semaphore closed unexpectedly")
            }
            Self::TaskJoin { task, source } => write!(f, "{task} task failed: {source}"),
            Self::NotFound { resource, id } => write!(f, "{resource} not found: {id}"),
            Self::Probe { message } => f.write_str(message),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } | Self::TemplateRead { source, .. } => Some(source),
            Self::Utf8(e) => Some(e),
            Self::FromUtf8(e) => Some(e),
            Self::ParseInt(e) => Some(e),
            Self::Json(e) => Some(e),
            Self::Sql(e) => Some(e),
            Self::Http(e) => Some(e),
            Self::Redis(e) => Some(e),
            Self::Template(e) | Self::TemplateRender { source: e, .. } => Some(e),
            Self::TaskJoin { source, .. } => Some(source),
            Self::AtomicWrite { source, .. } => Some(source),
            Self::ProcessSpawn { source, .. } => Some(source),
            Self::Config { .. }
            | Self::Validation { .. }
            | Self::MissingParent { .. }
            | Self::ExternalCommandTimedOut { .. }
            | Self::ExternalCommandFailed { .. }
            | Self::ProcessExitedEarly { .. }
            | Self::ProcessStartTimeout { .. }
            | Self::ClashApiStatus { .. }
            | Self::ClashApi { .. }
            | Self::FrameTooLarge { .. }
            | Self::FrameIncomplete
            | Self::ReadTimeout { .. }
            | Self::BadRequest { .. }
            | Self::UnsupportedOperation { .. }
            | Self::SemaphoreClosed { .. }
            | Self::NotFound { .. }
            | Self::Probe { .. } => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(source: std::io::Error) -> Self {
        Self::Io {
            op: "io",
            path: None,
            source,
        }
    }
}

impl From<std::str::Utf8Error> for Error {
    fn from(e: std::str::Utf8Error) -> Self {
        Self::Utf8(e)
    }
}

impl From<std::string::FromUtf8Error> for Error {
    fn from(e: std::string::FromUtf8Error) -> Self {
        Self::FromUtf8(e)
    }
}

impl From<std::num::ParseIntError> for Error {
    fn from(e: std::num::ParseIntError) -> Self {
        Self::ParseInt(e)
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        Self::Sql(e)
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Self::Http(e)
    }
}

impl From<redis::RedisError> for Error {
    fn from(e: redis::RedisError) -> Self {
        Self::Redis(e)
    }
}

impl From<crate::template::RenderError> for Error {
    fn from(e: crate::template::RenderError) -> Self {
        Self::Template(e)
    }
}

// laravel_crypt::CryptError From-impl removed in v0.4.0 (see Error
// variant comment above for the rationale).

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::error::Error as _;

    #[test]
    fn wire_code_is_stable_for_boundary_errors() {
        assert_eq!(
            Error::FrameTooLarge { limit: 16 }.wire_code(),
            "request_too_large"
        );
        assert_eq!(
            Error::ReadTimeout {
                timeout: Duration::from_secs(1),
            }
            .wire_code(),
            "read_timeout"
        );
    }

    #[tokio::test]
    async fn task_join_error_has_stable_wire_code_and_source() {
        let handle = tokio::spawn(async {
            std::future::pending::<()>().await;
        });
        handle.abort();
        let source = handle.await.expect_err("aborted task returns JoinError");
        let err = Error::TaskJoin {
            task: "unit-test task",
            source,
        };

        assert_eq!(err.wire_code(), "internal_task_error");
        assert!(err.source().is_some());
    }

    #[test]
    fn io_path_preserves_source_chain() {
        let inner = std::io::Error::other("connection refused");
        let outer = Error::io_path("connect", "/run/core.sock", inner);

        assert!(outer
            .to_string()
            .contains("connect `/run/core.sock` failed"));
        let source = outer.source().expect("io source preserved");
        assert_eq!(source.to_string(), "connection refused");
    }

    #[test]
    fn config_error_has_no_source() {
        let e = Error::config("missing DOMAIN");
        assert_eq!(e.to_string(), "missing DOMAIN");
        assert!(e.source().is_none());
    }
}
