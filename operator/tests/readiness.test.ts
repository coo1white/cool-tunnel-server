// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/readiness.test.ts — pure readiness helpers.

import { expect, test } from "bun:test";
import { readinessAcmeDomain, readinessRedisBridgeAcked } from "../src/tasks/readiness";

test("readiness ACME probes the panel domain when present", () => {
    expect(readinessAcmeDomain({
        DOMAIN: "example.com",
        PANEL_DOMAIN: "panel.example.com",
    })).toBe("panel.example.com");
});

test("readiness ACME falls back to apex domain", () => {
    expect(readinessAcmeDomain({ DOMAIN: "example.com" })).toBe("example.com");
});

test("readiness Redis bridge accepts v0.4 daemon announce logs", () => {
    expect(readinessRedisBridgeAcked("revocation announce observed (no-op in v0.4.0)")).toBe(true);
    expect(readinessRedisBridgeAcked("revocation received")).toBe(true);
});
