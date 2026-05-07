// DoH (DNS-over-HTTPS) resolution helpers — RFC 1035 wire-format
// query construction and a single-shot probe used by both the
// component verifier (`components::verify_via_doh`) and the self-
// probe canary (`canary::probe`).
//
// Both callers need the same primitive — "given a hostname and a
// DoH endpoint, did the resolver return ≥1 answer?" — and the
// pre-cleanup code path duplicated the wire-format builder, the
// reqwest call, the ANCOUNT extraction, and the censorship-
// intercept error string across the two modules. Lifting both into
// `util::doh` collapses the duplication and keeps the wire-format
// + ANCOUNT semantics in one place; future RFC 1035 fixes (CNAME
// chasing, EDNS, etc.) only need to land here.
//
// The probe is deliberately ANCOUNT-only and does NOT extract the
// resolved IP. Callers that need the IP would parse the answer
// section; today nobody does, and the reachability tests
// (canary's "TCP-connect to docker-internal haproxy" + the
// component verifier's "DoH endpoint OK") work fine without it.

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
/// "Success" means the DoH endpoint returned an HTTP 2xx with a
/// well-formed message header containing ≥1 answer record.
/// `ANCOUNT=0` is treated as a failure (likely captive portal /
/// poisoner / NXDOMAIN-on-everything intercept) — IANA-managed
/// names like `example.com` always have A records, and the apex
/// of an operator's deployment has at least one A record by
/// definition (the install would never have succeeded otherwise).
///
/// # Errors
///
/// Returns `Err` when the wire-format query can't be built, the
/// HTTP request fails / times out, the resolver returns non-2xx,
/// the body is too short to parse a header, or `ANCOUNT == 0`.
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
        .map_err(|e| format!("HTTP client build failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Accept", "application/dns-message")
        .send()
        .await
        .map_err(|e| format!("DoH request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!(
            "DoH HTTP {status} (resolver may be censored or misconfigured)"
        ));
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| format!("DoH body read failed: {e}"))?;
    if body.len() < 12 {
        return Err(format!("DoH response too small ({} bytes)", body.len()));
    }
    let ancount = u16::from_be_bytes([body[6], body[7]]);
    if ancount == 0 {
        return Err(format!(
            "DoH returned 0 answer records for {name} (possible censorship intercept — try a different resolver via the panel)"
        ));
    }
    Ok(ancount)
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
}
