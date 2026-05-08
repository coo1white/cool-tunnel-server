// SPDX-License-Identifier: AGPL-3.0-only
//! DoH (DNS-over-HTTPS) resolution helpers — RFC 1035 wire-format
//! query construction and a single-shot probe used by both the
//! component verifier (`components::verify_via_doh`) and the self-
//! probe canary (`canary::probe`).
//!
//! Both callers need the same primitive — "given a hostname and a
//! DoH endpoint, did the resolver return ≥1 answer?" — and the
//! pre-cleanup code path duplicated the wire-format builder, the
//! reqwest call, the ANCOUNT extraction, and the censorship-
//! intercept error string across the two modules. Lifting both into
//! `util::doh` collapses the duplication and keeps the wire-format
//! + ANCOUNT semantics in one place; future RFC 1035 fixes (CNAME
//! chasing, EDNS, etc.) only need to land here.
//!
//! The probe is deliberately ANCOUNT-only and does NOT extract the
//! resolved IP. Callers that need the IP would parse the answer
//! section; today nobody does, and the reachability tests
//! (canary's "TCP-connect to docker-internal haproxy" + the
//! component verifier's "DoH endpoint OK") work fine without it.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::time::Duration;

/// 5-second wall-clock cap on the DoH HTTP round trip. DoH lookups
/// are typically <100 ms when the resolver is reachable; 5 s is
/// generous enough to absorb transient hiccups without stalling
/// the cron / component-check pass that calls this.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

/// Build an RFC 1035 wire-format DNS query for `name` IN A.
/// Standard query (QR=0, OPCODE=0), recursion desired (RD=1),
/// single question. Each label is `<length-byte><label-bytes>`,
/// terminated by a 0-byte; QTYPE = A (1), QCLASS = IN (1).
///
/// # Errors
///
/// Returns `Err` when the hostname is empty, contains an empty
/// label (e.g. `foo..bar`), or contains a label longer than 63
/// bytes (the DNS protocol cap).
pub fn build_dns_query(name: &str) -> std::result::Result<Vec<u8>, String> {
    let name = name.trim().trim_end_matches('.');
    if name.is_empty() {
        return Err("empty hostname".to_owned());
    }
    let mut buf = Vec::with_capacity(12 + name.len() + 6);
    buf.extend_from_slice(&[
        0x00, 0x01, // ID
        0x01, 0x00, // flags: standard query, RD=1
        0x00, 0x01, // QDCOUNT=1
        0x00, 0x00, // ANCOUNT=0
        0x00, 0x00, // NSCOUNT=0
        0x00, 0x00, // ARCOUNT=0
    ]);
    for label in name.split('.') {
        if label.is_empty() {
            return Err(format!("invalid hostname: `{name}` (empty label)"));
        }
        if label.len() > 63 {
            return Err(format!("invalid hostname: `{name}` (label > 63 bytes)"));
        }
        let len_byte = u8::try_from(label.len())
            .map_err(|_| format!("invalid hostname: `{name}` (label length > 255)"))?;
        buf.push(len_byte);
        buf.extend_from_slice(label.as_bytes());
    }
    buf.push(0x00);
    buf.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]);
    Ok(buf)
}

/// Resolve `name` IN A through `doh_url`. Returns `Ok(ancount)` on
/// success, `Err(human-readable reason)` on any failure.
///
/// "Success" means the DoH endpoint returned an HTTP 2xx, a
/// well-formed message header with `RCODE = NOERROR`, and at
/// least one answer record. The error path distinguishes the
/// RCODE classes — `SERVFAIL` (upstream auth-server failure),
/// `NXDOMAIN` (name doesn't exist), `REFUSED` (resolver policy
/// rejected) — so the operator gets an accurate diagnostic
/// instead of "possible censorship intercept" for every kind of
/// upstream hiccup.
///
/// `ANCOUNT == 0` *with* `RCODE == NOERROR` is the actual
/// censorship-intercept signal (a captive portal returning a
/// well-formed empty response).
///
/// Error messages deliberately omit the DoH URL — reqwest's
/// `Display` impl can include the full URL in connect / TLS
/// errors, which would leak any URL-embedded credentials
/// (`https://user:pass@host/path` form, accepted by reqwest
/// even though it's not standard for DoH) into the canary's
/// stored history and `docker compose logs`. The operator
/// already knows the URL — it's in the panel.
///
/// # Errors
///
/// Returns `Err` when the wire-format query can't be built, the
/// HTTP request fails / times out, the resolver returns non-2xx,
/// the body is too short to parse a header, the response RCODE
/// is non-zero, or `ANCOUNT == 0`.
pub async fn resolve_a(name: &str, doh_url: &str) -> std::result::Result<u16, String> {
    let query = build_dns_query(name)?;
    let b64 = URL_SAFE_NO_PAD.encode(&query);
    let url = if doh_url.contains('?') {
        format!("{doh_url}&dns={b64}")
    } else {
        format!("{doh_url}?dns={b64}")
    };

    let client = reqwest::Client::builder()
        .timeout(DEFAULT_TIMEOUT)
        .build()
        .map_err(|_| "HTTP client build failed".to_owned())?;
    let resp = client
        .get(&url)
        .header("Accept", "application/dns-message")
        .send()
        .await
        .map_err(reqwest_error_kind)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!(
            "DoH HTTP {status} (resolver may be censored or misconfigured)"
        ));
    }
    let body = resp.bytes().await.map_err(reqwest_error_kind)?;
    classify_dns_response(&body, name)
}

/// Pure post-fetch classifier — extracted from `resolve_a` so the
/// RCODE / ANCOUNT decision tree is unit-testable without a live
/// DoH endpoint. Returns the answer count on NOERROR + ANCOUNT > 0;
/// returns a human-readable error string for every other case
/// (size-too-small, RCODE != NOERROR, NOERROR-but-zero-answers).
///
/// Why this matters for the canary's operator-facing diagnostic:
/// pre-cleanup the code reported every non-success as "possible
/// censorship intercept", which sent operators chasing the wrong
/// root cause for legitimate upstream failures (SERVFAIL is
/// usually transient, NXDOMAIN means name-doesn't-exist, REFUSED
/// is a policy reject — none of those are censorship signals).
/// The branching here gives each class its own message.
fn classify_dns_response(body: &[u8], name: &str) -> std::result::Result<u16, String> {
    if body.len() < 12 {
        return Err(format!("DoH response too small ({} bytes)", body.len()));
    }

    // RFC 1035 §4.1.1: byte 3, lower 4 bits = RCODE.
    let rcode = body[3] & 0x0F;
    match rcode {
        0 => {} // NOERROR — fall through to ANCOUNT check.
        2 => return Err(format!("DoH SERVFAIL for {name} (upstream auth-server failure — usually transient; not a censorship signal)")),
        3 => return Err(format!("DoH NXDOMAIN for {name} (resolver claims this name does not exist — DNS hijacking if the name should resolve)")),
        5 => return Err(format!("DoH REFUSED for {name} (resolver policy rejected the query — try a different DoH endpoint)")),
        n => return Err(format!("DoH returned RCODE={n} for {name} (non-NOERROR; resolver may be censored or misconfigured)")),
    }

    let ancount = u16::from_be_bytes([body[6], body[7]]);
    if ancount == 0 {
        return Err(format!(
            "DoH returned NOERROR with 0 answer records for {name} (likely captive portal / DNS poisoner — try a different resolver via the panel)"
        ));
    }
    Ok(ancount)
}

/// Reqwest's `Display` impl can include the request URL in
/// connect / TLS error messages. The DoH URL is operator-
/// controlled and could carry embedded credentials. Strip the
/// URL by classifying the error kind via reqwest's typed
/// predicates and return only the category name.
fn reqwest_error_kind(e: reqwest::Error) -> String {
    let kind = if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connection error"
    } else if e.is_decode() {
        "decode error"
    } else if e.is_redirect() {
        "redirect error"
    } else if e.is_status() {
        "status error"
    } else {
        "request error"
    };
    format!("DoH request failed ({kind})")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn dns_query_for_example_com_matches_known_29_byte_form() {
        let q = build_dns_query("example.com").unwrap();
        let expected: &[u8] = &[
            0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, b'e',
            b'x', b'a', b'm', b'p', b'l', b'e', 0x03, b'c', b'o', b'm', 0x00, 0x00, 0x01, 0x00,
            0x01,
        ];
        assert_eq!(q, expected);
    }

    #[test]
    fn dns_query_strips_trailing_dot() {
        let a = build_dns_query("proxy.example.com").unwrap();
        let b = build_dns_query("proxy.example.com.").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn dns_query_rejects_empty() {
        assert!(build_dns_query("").is_err());
        assert!(build_dns_query("   ").is_err());
    }

    #[test]
    fn dns_query_rejects_empty_label() {
        assert!(build_dns_query("foo..bar").is_err());
    }

    #[test]
    fn dns_query_rejects_oversize_label() {
        let long = "a".repeat(64);
        assert!(build_dns_query(&format!("{long}.example.com")).is_err());
    }

    /// Build a synthetic DoH response header for testing
    /// `classify_dns_response`. All test inputs are valid per
    /// RFC 1035 §4.1.1 — only the RCODE nibble (low 4 bits of
    /// byte 3) and ANCOUNT (bytes 6-7) actually matter for our
    /// classifier. ID, flags, QDCOUNT, NSCOUNT, ARCOUNT can be
    /// anything since we never inspect them.
    fn synthetic_response(rcode: u8, ancount: u16) -> Vec<u8> {
        let mut buf = vec![
            0x00,
            0x01, // ID
            0x80,
            (rcode & 0x0F), // flags: QR=1, OPCODE=0, AA=0, TC=0, RD=0; RCODE in low nibble of byte 3
            0x00,
            0x01, // QDCOUNT
            0x00,
            0x00, // ANCOUNT placeholder (filled below)
            0x00,
            0x00, // NSCOUNT
            0x00,
            0x00, // ARCOUNT
        ];
        let ancount_bytes = ancount.to_be_bytes();
        buf[6] = ancount_bytes[0];
        buf[7] = ancount_bytes[1];
        buf
    }

    #[test]
    fn classify_rejects_short_body() {
        let result = classify_dns_response(&[0x00; 11], "example.com");
        assert!(matches!(result, Err(ref e) if e.contains("too small")));
    }

    #[test]
    fn classify_noerror_with_answers_returns_ancount() {
        let body = synthetic_response(0, 3);
        assert_eq!(classify_dns_response(&body, "example.com"), Ok(3));
    }

    #[test]
    fn classify_noerror_zero_answers_signals_censorship_intercept() {
        let body = synthetic_response(0, 0);
        let err = classify_dns_response(&body, "proxy.example.com").unwrap_err();
        assert!(
            err.contains("NOERROR with 0 answer records"),
            "should call out NOERROR-with-zero-answers as the actual intercept signal: {err}"
        );
        assert!(
            err.contains("proxy.example.com"),
            "should echo the queried name"
        );
    }

    #[test]
    fn classify_servfail_is_not_reported_as_censorship() {
        let body = synthetic_response(2, 0);
        let err = classify_dns_response(&body, "example.com").unwrap_err();
        assert!(
            err.contains("SERVFAIL"),
            "should name the RCODE class: {err}"
        );
        // The SERVFAIL message intentionally contains the word
        // "censorship" in the phrase "not a censorship signal";
        // assert the operator-actionable framing instead. The
        // message must say it's transient and NOT use the
        // alarming "intercept" / "poisoner" vocabulary that the
        // genuine censorship branches do.
        assert!(
            err.contains("transient"),
            "SERVFAIL message must frame as transient upstream failure: {err}"
        );
        assert!(
            !err.contains("intercept") && !err.contains("poisoner"),
            "SERVFAIL must not use the censorship-event vocabulary: {err}"
        );
    }

    #[test]
    fn classify_nxdomain_distinguishes_from_intercept() {
        let body = synthetic_response(3, 0);
        let err = classify_dns_response(&body, "doesnotexist.invalid").unwrap_err();
        assert!(
            err.contains("NXDOMAIN"),
            "should name the RCODE class: {err}"
        );
        assert!(
            err.contains("DNS hijacking"),
            "should hint at hijacking when name should exist: {err}"
        );
    }

    #[test]
    fn classify_refused_directs_to_alternate_resolver() {
        let body = synthetic_response(5, 0);
        let err = classify_dns_response(&body, "example.com").unwrap_err();
        assert!(
            err.contains("REFUSED"),
            "should name the RCODE class: {err}"
        );
        assert!(
            err.contains("different DoH endpoint"),
            "should suggest the recovery action: {err}"
        );
    }

    #[test]
    fn classify_unknown_rcode_falls_through_to_generic_error() {
        // RCODE=4 (NotImp) and others: we don't have a class-
        // specific message. Fall-through must still surface the
        // numeric RCODE for operator triage.
        let body = synthetic_response(4, 0);
        let err = classify_dns_response(&body, "example.com").unwrap_err();
        assert!(
            err.contains("RCODE=4"),
            "fall-through must echo the numeric RCODE: {err}"
        );
    }
}
