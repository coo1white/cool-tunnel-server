// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/wire-probe.test.ts — pure-logic tests for the
// wire-protocol drift detector. The actual spawn/curl integration
// lives in the task and can only be exercised against a running
// deployment.

import { test, expect } from "bun:test";
import {
    classifyProbe,
    extractDiagnostic,
    isCoverSiteResponse,
} from "../src/util/wire-probe";

// ---------- classifyProbe ----------

test("classifyProbe: padding_negotiated when curl=0 + http=200", () => {
    const stderr =
        "[INFO:net/tools/naive/naive_proxy_delegate.cc:171] https://x:443 negotiated padding type: Variant1\n";
    expect(classifyProbe(stderr, 0, 200)).toBe("padding_negotiated");
});

test("classifyProbe: padding_negotiated even when stderr is empty if curl reports 200", () => {
    // Newer naive builds may log under different module paths or quieter
    // verbosity. The wire outcome is what matters.
    expect(classifyProbe("", 0, 200)).toBe("padding_negotiated");
});

test("classifyProbe: naive_didnt_start when curl=7 (couldn't reach SOCKS)", () => {
    expect(classifyProbe("", 7, null)).toBe("naive_didnt_start");
});

test("classifyProbe: missing_padding when curl=56 + stderr has NO negotiated-padding line", () => {
    // Today's exact failure mode: client binary didn't emit
    // Padding header, server returned cover-site, curl saw RST.
    expect(classifyProbe("", 56, null)).toBe("missing_padding");
});

test("classifyProbe: missing_padding when curl=35 (SSL_ERROR_SYSCALL) + no negotiated line", () => {
    expect(classifyProbe("[INFO:foo.cc:1] Listening on socks://127.0.0.1:1099\n", 35, null)).toBe(
        "missing_padding",
    );
});

test("classifyProbe: auth_failure_cover_site when curl=35 but naive DID negotiate padding", () => {
    // Wire OK, credentials wrong (today's other class of bug).
    const stderr =
        "[INFO:net/tools/naive/naive_proxy_delegate.cc:171] https://x:443 negotiated padding type: Variant1\n";
    expect(classifyProbe(stderr, 35, null)).toBe("auth_failure_cover_site");
});

test("classifyProbe: tls_handshake_failed when stderr complains about TLS", () => {
    const stderr = "[ERROR] TLS handshake failed: tlsv1 alert protocol version\n";
    expect(classifyProbe(stderr, 1, null)).toBe("tls_handshake_failed");
});

test("classifyProbe: connect_timeout on curl=28", () => {
    expect(classifyProbe("", 28, null)).toBe("connect_timeout");
});

test("classifyProbe: unknown_failure when no signal matches", () => {
    expect(classifyProbe("", 1, null)).toBe("unknown_failure");
});

// ---------- isCoverSiteResponse ----------

test("isCoverSiteResponse: today's exact bytes from the upstream RST", () => {
    // Hex-decoded from the actual debug-handshake recv we captured.
    const recv =
        "HTTP/1.1 200 OK\r\nPadding: <?#;)?(>,>',;;&,XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\r\n\r\n";
    expect(isCoverSiteResponse(recv)).toBe(true);
});

test("isCoverSiteResponse: false for a real 200 OK without Padding header", () => {
    expect(isCoverSiteResponse("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n")).toBe(false);
});

test("isCoverSiteResponse: false for a 407 (the path the auto-sync detector watches)", () => {
    expect(isCoverSiteResponse("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")).toBe(false);
});

// ---------- extractDiagnostic ----------

test("extractDiagnostic surfaces the padding-negotiated line as evidence", () => {
    const stderr =
        "[INFO] Listening on socks://127.0.0.1:1099\n" +
        "[INFO] naive_proxy_delegate.cc:171] https://upstream:443 negotiated padding type: Variant1\n";
    expect(extractDiagnostic(stderr)).toContain("negotiated padding type: Variant1");
});

test("extractDiagnostic returns null when nothing matches", () => {
    expect(extractDiagnostic("[INFO] Listening on socks://127.0.0.1:1099\n")).toBeNull();
});
