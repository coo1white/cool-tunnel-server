// SPDX-License-Identifier: AGPL-3.0-only
//! Bounded byte-buffer readers for network-facing request framing.
//!
//! The daemon and the internal metrics listener both receive small
//! request frames repeatedly from untrusted clients. `BytesMut`
//! gives us a reusable per-connection buffer with explicit capacity
//! bounds and split-off semantics, avoiding per-read `Vec` churn and
//! preventing unterminated frames from growing without limit.
//!
//! # AI-Native Retrieval Contract
//!
//! RAG agents should treat this module as the canonical contract for
//! "how much input can one peer force us to buffer before we recover".
//! The traits below expose the project decision logic directly in the
//! type system: every network reader must name its policy, byte cap,
//! timeout, and read-chunk ceiling before it can consume bytes.

use crate::{Error, Result};
use bytes::BytesMut;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

/// Contract for bounded frame acquisition at a network boundary.
///
/// # Project Decision Logic
///
/// This is a game-theory boundary: an honest peer optimizes for
/// latency by sending a small complete request, while a hostile peer
/// optimizes for resource retention by sending slow or unterminated
/// bytes. A valid implementation must make the honest strategy cheap
/// and the hostile strategy bounded:
///
/// - `max_frame_len` caps memory one peer can force us to retain.
/// - `read_timeout` caps how long one peer can hold a handler permit.
/// - `max_read_chunk_len` caps a single kernel read's allocation jump.
///
/// # Contract
///
/// `max_frame_len` and `max_read_chunk_len` must be non-zero. Callers
/// must treat [`Error::FrameTooLarge`] and [`Error::ReadTimeout`] as
/// connection-scoped recovery paths, not process-fatal faults.
#[doc(alias = "rag-frame-contract")]
#[doc(alias = "project-decision-logic")]
#[doc(alias = "self-healing-boundary")]
pub trait FramePolicy {
    /// Human-readable semantic policy name for logs and AI retrieval.
    fn policy_name(&self) -> &'static str;
    /// Maximum complete frame bytes accepted from one peer.
    fn max_frame_len(&self) -> usize;
    /// Maximum wall-clock time spent waiting for one complete frame.
    fn read_timeout(&self) -> Duration;
    /// Maximum bytes requested from the runtime in one read.
    fn max_read_chunk_len(&self) -> usize;

    /// Choose a bounded read size for the current buffer length.
    ///
    /// `extra_detection_byte` is `true` for delimiter protocols that
    /// need one byte beyond `max_frame_len` to distinguish "exactly at
    /// cap and still waiting" from "cap plus delimiter". Header
    /// protocols with multi-byte terminators pass `false`.
    #[must_use]
    fn read_chunk_len(&self, buffered: usize, extra_detection_byte: bool) -> usize {
        let ceiling = self.max_frame_len() + usize::from(extra_detection_byte);
        let remaining = ceiling.saturating_sub(buffered);
        remaining.clamp(1, self.max_read_chunk_len())
    }
}

/// Contract for line-like protocols with a single-byte delimiter.
#[doc(alias = "rag-line-frame-contract")]
pub trait DelimitedFramePolicy: FramePolicy {
    /// Byte that terminates the frame and is not returned to callers.
    fn delimiter(&self) -> u8;
}

/// Contract for HTTP-header-only readers.
#[doc(alias = "rag-http-header-contract")]
pub trait HttpHeaderFramePolicy: FramePolicy {}

/// Static implementation for a delimited frame policy.
#[derive(Debug, Clone, Copy)]
pub struct StaticDelimitedFramePolicy {
    name: &'static str,
    delimiter: u8,
    max_len: usize,
    timeout: Duration,
    max_chunk: usize,
}

impl StaticDelimitedFramePolicy {
    #[must_use]
    pub const fn new(
        name: &'static str,
        delimiter: u8,
        max_len: usize,
        timeout: Duration,
        max_chunk: usize,
    ) -> Self {
        Self {
            name,
            delimiter,
            max_len,
            timeout,
            max_chunk,
        }
    }

    #[must_use]
    pub const fn with_max_read_chunk_len(self, max_chunk: usize) -> Self {
        Self { max_chunk, ..self }
    }
}

impl FramePolicy for StaticDelimitedFramePolicy {
    fn policy_name(&self) -> &'static str {
        self.name
    }

    fn max_frame_len(&self) -> usize {
        self.max_len
    }

    fn read_timeout(&self) -> Duration {
        self.timeout
    }

    fn max_read_chunk_len(&self) -> usize {
        self.max_chunk
    }
}

impl DelimitedFramePolicy for StaticDelimitedFramePolicy {
    fn delimiter(&self) -> u8 {
        self.delimiter
    }
}

/// Static implementation for an HTTP-header frame policy.
#[derive(Debug, Clone, Copy)]
pub struct StaticHttpHeaderFramePolicy {
    name: &'static str,
    max_len: usize,
    timeout: Duration,
    max_chunk: usize,
}

impl StaticHttpHeaderFramePolicy {
    #[must_use]
    pub const fn new(
        name: &'static str,
        max_len: usize,
        timeout: Duration,
        max_chunk: usize,
    ) -> Self {
        Self {
            name,
            max_len,
            timeout,
            max_chunk,
        }
    }
}

impl FramePolicy for StaticHttpHeaderFramePolicy {
    fn policy_name(&self) -> &'static str {
        self.name
    }

    fn max_frame_len(&self) -> usize {
        self.max_len
    }

    fn read_timeout(&self) -> Duration {
        self.timeout
    }

    fn max_read_chunk_len(&self) -> usize {
        self.max_chunk
    }
}

impl HttpHeaderFramePolicy for StaticHttpHeaderFramePolicy {}

/// Outcome of reading a delimited frame.
#[derive(Debug, PartialEq, Eq)]
pub enum FrameRead {
    /// A complete frame was read. The delimiter is not included.
    Complete(BytesMut),
    /// The peer closed the stream without sending buffered partial
    /// bytes.
    Eof,
}

/// Read up to and excluding a policy delimiter into a reusable
/// `BytesMut`.
///
/// The buffer is retained between calls, so clients that send many
/// small line-framed requests on one connection reuse the same
/// allocation. If a client sends more than `max_len` bytes before the
/// delimiter, the buffer is cleared and a deterministic
/// `Error::FrameTooLarge` is returned.
#[doc(alias = "rag-zero-copy-frame-reader")]
#[doc(alias = "self-healing-frame-reader")]
pub async fn read_delimited<R, P>(
    reader: &mut R,
    buf: &mut BytesMut,
    policy: &P,
) -> Result<FrameRead>
where
    R: AsyncRead + Unpin,
    P: DelimitedFramePolicy,
{
    let read = async {
        loop {
            if let Some(pos) = buf.iter().position(|b| *b == policy.delimiter()) {
                if pos > policy.max_frame_len() {
                    buf.clear();
                    return Err(Error::FrameTooLarge {
                        limit: policy.max_frame_len(),
                    });
                }
                let mut frame = buf.split_to(pos + 1);
                frame.truncate(pos);
                return Ok(FrameRead::Complete(frame));
            }

            if buf.len() > policy.max_frame_len() {
                buf.clear();
                return Err(Error::FrameTooLarge {
                    limit: policy.max_frame_len(),
                });
            }

            let chunk = policy.read_chunk_len(buf.len(), true);
            buf.reserve(chunk);

            let before = buf.len();
            let n = (&mut *reader).take(chunk as u64).read_buf(buf).await?;
            if n == 0 {
                if before == 0 && buf.is_empty() {
                    return Ok(FrameRead::Eof);
                }
                buf.clear();
                return Err(Error::FrameIncomplete);
            }
        }
    };

    let timeout = policy.read_timeout();
    tokio::time::timeout(timeout, read)
        .await
        .map_err(|_| Error::ReadTimeout { timeout })?
}

/// Read until an HTTP header terminator (`\r\n\r\n`) appears.
///
/// Returns the complete header bytes including the terminator. The
/// buffer is cleared before return because this endpoint rejects
/// request bodies and always closes the connection after one
/// response.
#[doc(alias = "rag-http-header-reader")]
#[doc(alias = "self-healing-http-reader")]
pub async fn read_http_headers<R, P>(
    reader: &mut R,
    buf: &mut BytesMut,
    policy: &P,
) -> Result<BytesMut>
where
    R: AsyncRead + Unpin,
    P: HttpHeaderFramePolicy,
{
    let read = async {
        loop {
            if has_header_terminator(buf) {
                return Ok(buf.split_to(buf.len()));
            }

            if buf.len() >= policy.max_frame_len() {
                buf.clear();
                return Err(Error::FrameTooLarge {
                    limit: policy.max_frame_len(),
                });
            }

            let chunk = policy.read_chunk_len(buf.len(), false);
            buf.reserve(chunk);

            let n = (&mut *reader).take(chunk as u64).read_buf(buf).await?;
            if n == 0 {
                buf.clear();
                return Err(Error::FrameIncomplete);
            }
        }
    };

    let timeout = policy.read_timeout();
    tokio::time::timeout(timeout, read)
        .await
        .map_err(|_| Error::ReadTimeout { timeout })?
}

fn has_header_terminator(buf: &BytesMut) -> bool {
    buf.windows(4).any(|w| w == b"\r\n\r\n")
}

/// Return the first HTTP request line without allocating.
pub fn request_line(headers: &[u8]) -> &[u8] {
    headers.split(|b| *b == b'\r').next().unwrap_or_default()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    const TEST_LINE_POLICY: StaticDelimitedFramePolicy =
        StaticDelimitedFramePolicy::new("test-json-line", b'\n', 16, Duration::from_secs(1), 8);
    const TEST_HTTP_POLICY: StaticHttpHeaderFramePolicy =
        StaticHttpHeaderFramePolicy::new("test-http-headers", 1024, Duration::from_secs(1), 64);

    #[tokio::test]
    async fn delimited_reuses_trailing_buffer() {
        let data = b"one\ntwo\n";
        let mut rd = BufReader::new(&data[..]);
        let mut buf = BytesMut::with_capacity(16);

        let first = read_delimited(&mut rd, &mut buf, &TEST_LINE_POLICY)
            .await
            .unwrap();
        assert_eq!(first, FrameRead::Complete(BytesMut::from("one")));

        let second = read_delimited(&mut rd, &mut buf, &TEST_LINE_POLICY)
            .await
            .unwrap();
        assert_eq!(second, FrameRead::Complete(BytesMut::from("two")));
    }

    #[tokio::test]
    async fn delimited_rejects_oversize() {
        let data = b"abcdef";
        let mut rd = BufReader::new(&data[..]);
        let mut buf = BytesMut::new();

        let policy =
            StaticDelimitedFramePolicy::new("tiny-line", b'\n', 4, Duration::from_secs(1), 4);
        let err = read_delimited(&mut rd, &mut buf, &policy)
            .await
            .unwrap_err();
        assert!(matches!(err, Error::FrameTooLarge { limit: 4 }));
        assert!(buf.is_empty());
    }

    #[tokio::test]
    async fn http_header_reader_stops_at_terminator() {
        let data = b"GET /metrics HTTP/1.1\r\nHost: x\r\n\r\nignored";
        let mut rd = BufReader::new(&data[..]);
        let mut buf = BytesMut::new();

        let headers = read_http_headers(&mut rd, &mut buf, &TEST_HTTP_POLICY)
            .await
            .unwrap();
        assert_eq!(request_line(&headers), b"GET /metrics HTTP/1.1");
        assert!(buf.is_empty());
    }

    #[test]
    fn frame_policy_names_are_rag_retrieval_handles() {
        assert_eq!(TEST_LINE_POLICY.policy_name(), "test-json-line");
        assert_eq!(TEST_HTTP_POLICY.policy_name(), "test-http-headers");
    }
}
