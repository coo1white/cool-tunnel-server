// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/wire-probe.ts — wire-protocol drift detection.
//
// Today's incident: a bundled `naive` client binary appeared to be
// the right version (`naive --version` matched the server pin) but
// was a build that didn't emit the `Padding:` HTTP header
// NaiveProxy / sing-box now requires. Every static check passed.
// Auth still failed in production because the wire-level protocol
// had silently drifted between the two builds.
//
// The only reliable detector is to *do the wire negotiation* and
// observe whether the server returns the cover-site auth-failure
// pattern or accepts the CONNECT. This module pins the small
// amount of logic that can be tested without spawning naive:
//   - which stderr lines mean "padding negotiated OK"
//   - which mean "auth-failure cover-site"
//   - the report shape callers emit
//
// The task (operator/src/tasks/wire-probe.ts) does the actual
// spawn + curl-through-SOCKS + result wiring.

// Severity classification mirrors drift-check so a future
// composite "doctor cleartext-and-wire" view can merge them.
export type ProbeOutcome =
    | "padding_negotiated"      // naive logged its successful padding handshake
    | "auth_failure_cover_site" // got the 200+Padding+RST pattern
    | "missing_padding"         // sing-box log on the SERVER would say this
    | "tls_handshake_failed"    // never reached the CONNECT layer
    | "connect_timeout"         // upstream didn't respond
    | "naive_didnt_start"       // local listener never came up
    | "unknown_failure";        // anything else

export interface ProbeResult {
    readonly outcome: ProbeOutcome;
    readonly ok: boolean;
    readonly httpCode: number | null;
    readonly elapsedMs: number;
    // First line of naive's stderr matching one of the diagnostic
    // patterns, if any. Null when no diagnostic line was found.
    readonly diagnostic: string | null;
    // Optional curl exit code, when curl ran.
    readonly curlExit?: number;
}

// naive's INFO log line we hunt for to confirm padding worked.
// The version we tested today emitted:
//   "[...]naive_proxy_delegate.cc:171] https://<host>:<port> negotiated padding type: Variant1"
// Match generously — future versions may rename `Variant1` to
// `V1`, `padv1`, or similar. We just need "negotiated padding
// type: <anything-non-empty>".
const NEGOTIATED_PADDING_PATTERN = /negotiated padding type:\s*\S+/i;

// Server cover-site response signature (what curl receives when
// upstream auth fails). Padding header with random punctuation
// + Xs, followed by an RST. The "Padding:" prefix is enough.
const COVER_SITE_PATTERN = /^HTTP\/1\.[01]\s+200\s+OK\s*$/m;
const COVER_SITE_PADDING_HEADER_PATTERN = /^Padding:\s+/m;

// Pattern naive logs when it gave up on the CONNECT layer.
const TLS_HANDSHAKE_FAIL_PATTERN = /(TLS handshake fail|SSL_ERROR_|ssl alert)/i;

// Pure: classify naive's captured stderr + the curl exit code into
// an outcome. Exported for tests.
//
// Inputs:
//   stderr       — everything naive printed on stderr while the
//                  probe was alive. Multi-line OK.
//   curlExit     — exit code curl returned. 0 = HTTP success
//                  (tunnel worked end-to-end), 56 = "Recv failure
//                  / Connection reset" (cover-site path), 35 =
//                  SSL_ERROR_SYSCALL post-CONNECT (also cover-
//                  site path, RST mid-TLS-handshake), 7 = couldn't
//                  reach the SOCKS listener.
//   httpCode     — HTTP status curl saw (0 / null if no body).
export function classifyProbe(
    stderr: string,
    curlExit: number,
    httpCode: number | null,
): ProbeOutcome {
    // Fast path: curl exit 0 + HTTP 200 + naive logged "negotiated
    // padding type" — the tunnel works.
    if (curlExit === 0 && httpCode !== null && httpCode >= 200 && httpCode < 400) {
        if (NEGOTIATED_PADDING_PATTERN.test(stderr)) {
            return "padding_negotiated";
        }
        // Tunnel worked but naive didn't say it negotiated padding.
        // Treat as success-with-unknown — could be a newer log
        // format. The wire result is what we care about.
        return "padding_negotiated";
    }

    if (curlExit === 7) {
        return "naive_didnt_start";
    }

    // 56 = curl: (56) Recv failure / Connection reset by peer
    // 35 = curl: (35) SSL_ERROR_SYSCALL
    // Both are what the cover-site path produces.
    if (curlExit === 35 || curlExit === 56) {
        // If we ALSO see naive log a padding-negotiated line, the
        // upstream is rotating credentials — wire layer is fine,
        // credentials drifted. The drift-check task surfaces that.
        // Otherwise this is true protocol drift.
        if (NEGOTIATED_PADDING_PATTERN.test(stderr)) {
            return "auth_failure_cover_site";
        }
        return "missing_padding";
    }

    if (TLS_HANDSHAKE_FAIL_PATTERN.test(stderr)) {
        return "tls_handshake_failed";
    }

    // curl: (28) Operation timed out — upstream blackholed.
    if (curlExit === 28) {
        return "connect_timeout";
    }

    return "unknown_failure";
}

// Pure: detect whether a raw upstream-response capture (from a
// hand-driven CONNECT, without going through naive at all) is the
// cover-site auth-failure pattern. Used by future deeper probes
// that bypass the local naive entirely. Exported for tests.
export function isCoverSiteResponse(rawResponse: string): boolean {
    return (
        COVER_SITE_PATTERN.test(rawResponse) &&
        COVER_SITE_PADDING_HEADER_PATTERN.test(rawResponse)
    );
}

// Pure: extract the first line of naive's stderr that matches any
// known diagnostic pattern, for inclusion in the report. Returns
// null when no matching line is found. Exported for tests.
export function extractDiagnostic(stderr: string): string | null {
    for (const line of stderr.split("\n")) {
        if (NEGOTIATED_PADDING_PATTERN.test(line)) return line.trim();
        if (TLS_HANDSHAKE_FAIL_PATTERN.test(line)) return line.trim();
    }
    return null;
}

// Pure: render a one-line summary for human output. Cleartext
// passwords never appear (probe doesn't have access to them
// anyway — just the wire negotiation result).
export function renderProbeLine(result: ProbeResult): string {
    const tag = result.ok ? "OK  " : "FAIL";
    const code = result.httpCode === null ? "—" : String(result.httpCode);
    const diag = result.diagnostic ? `  (${result.diagnostic})` : "";
    return `${tag}  outcome=${result.outcome.padEnd(24)}  http=${code.padEnd(3)}  elapsed=${result.elapsedMs}ms${diag}`;
}
