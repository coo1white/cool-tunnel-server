// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/sot.test.ts — fixture equivalence logic for the
// panel_domain SoT validator (operator/src/util/sot.ts).

import { test, expect } from "bun:test";
import {
    FIXTURES,
    checkOutcome,
    formatOutcome,
    runFixtures,
    type Fixture,
    type ProbeResult,
} from "../src/util/sot";
import { parseMode } from "../verify-sot";

test("FIXTURES has exactly 5 cases — matches the bash original", () => {
    expect(FIXTURES).toHaveLength(5);
    expect(FIXTURES.map((f) => f.label)).toEqual([
        "explicit PANEL_DOMAIN takes priority",
        "empty PANEL_DOMAIN falls back to panel.<DOMAIN>",
        "empty DOMAIN with explicit PANEL_DOMAIN",
        "whitespace PANEL_DOMAIN trimmed → fallback",
        "both empty fails fast",
    ]);
});

test("checkOutcome: pass when PHP == Rust == expected and Rust exit 0", () => {
    const fixture: Fixture = {
        label: "x",
        domain: "example.com",
        panel_domain: "admin.example.com",
        expected: "admin.example.com",
    };
    const probe: ProbeResult = {
        php: "admin.example.com",
        rust: "admin.example.com",
        rustExit: 0,
    };
    expect(checkOutcome(fixture, probe)).toBe(true);
});

test("checkOutcome: fail when PHP != Rust", () => {
    const fixture: Fixture = {
        label: "x",
        domain: "example.com",
        panel_domain: "admin.example.com",
        expected: "admin.example.com",
    };
    const probe: ProbeResult = {
        php: "admin.example.com",
        rust: "other.example.com",
        rustExit: 0,
    };
    expect(checkOutcome(fixture, probe)).toBe(false);
});

test("checkOutcome: fail when Rust exits non-zero even if outputs match expected", () => {
    const fixture: Fixture = {
        label: "x",
        domain: "example.com",
        panel_domain: "admin.example.com",
        expected: "admin.example.com",
    };
    const probe: ProbeResult = {
        php: "admin.example.com",
        rust: "admin.example.com",
        rustExit: 1,
    };
    expect(checkOutcome(fixture, probe)).toBe(false);
});

test("checkOutcome: <fail> fixture passes when PHP empty AND Rust non-zero exit", () => {
    const fixture: Fixture = { label: "x", domain: "", panel_domain: "", expected: null };
    expect(checkOutcome(fixture, { php: "", rust: "", rustExit: 1 })).toBe(true);
    expect(checkOutcome(fixture, { php: "", rust: "anything", rustExit: 2 })).toBe(true);
});

test("checkOutcome: <fail> fixture fails when PHP is non-empty", () => {
    const fixture: Fixture = { label: "x", domain: "", panel_domain: "", expected: null };
    expect(checkOutcome(fixture, { php: "anything", rust: "", rustExit: 1 })).toBe(false);
});

test("checkOutcome: <fail> fixture fails when Rust exits 0", () => {
    const fixture: Fixture = { label: "x", domain: "", panel_domain: "", expected: null };
    expect(checkOutcome(fixture, { php: "", rust: "", rustExit: 0 })).toBe(false);
});

test("runFixtures aggregates pass/fail counts across the matrix", async () => {
    // Mock runner: returns the expected value for non-fail fixtures
    // and the canonical fail signal otherwise. Every fixture should
    // pass.
    const summary = await runFixtures(async (f) => {
        if (f.expected === null) return { php: "", rust: "", rustExit: 1 };
        return { php: f.expected, rust: f.expected, rustExit: 0 };
    });
    expect(summary.passed).toBe(5);
    expect(summary.failed).toBe(0);
});

test("runFixtures surfaces a per-fixture failure", async () => {
    // Mock runner that mis-implements PHP for fixture 2 (returns
    // "wrong" instead of "panel.example.com").
    const summary = await runFixtures(async (f) => {
        if (f.expected === null) return { php: "", rust: "", rustExit: 1 };
        if (f.label.startsWith("empty PANEL_DOMAIN")) {
            return { php: "wrong", rust: f.expected, rustExit: 0 };
        }
        return { php: f.expected, rust: f.expected, rustExit: 0 };
    });
    expect(summary.passed).toBe(4);
    expect(summary.failed).toBe(1);
    const failed = summary.outcomes.find((o) => !o.pass);
    expect(failed?.fixture.label).toContain("empty PANEL_DOMAIN");
});

test("formatOutcome shows ✓ for a pass", () => {
    const fixture = FIXTURES[0]!;
    const text = formatOutcome({
        fixture,
        probe: { php: fixture.expected!, rust: fixture.expected!, rustExit: 0 },
        pass: true,
    });
    expect(text).toBe(`  ✓ ${fixture.label}`);
});

test("formatOutcome shows the expected/got block for a non-fail failure", () => {
    const fixture: Fixture = {
        label: "demo",
        domain: "example.com",
        panel_domain: "admin.example.com",
        expected: "admin.example.com",
    };
    const text = formatOutcome({
        fixture,
        probe: { php: "wrong", rust: "admin.example.com", rustExit: 0 },
        pass: false,
    });
    expect(text).toContain("✗ demo");
    expect(text).toContain('expected: "admin.example.com"');
    expect(text).toContain('PHP:      "wrong"');
    expect(text).toContain('Rust:     "admin.example.com" (exit=0)');
});

test("formatOutcome shows the <fail> diagnostic block for fail-fixture mismatch", () => {
    const fixture: Fixture = { label: "all empty", domain: "", panel_domain: "", expected: null };
    const text = formatOutcome({
        fixture,
        probe: { php: "leak", rust: "leak", rustExit: 0 },
        pass: false,
    });
    expect(text).toContain("expected: <fail>");
    expect(text).toContain("empty=false");
    expect(text).toContain("(exit=0)");
});

test("parseMode returns the mode for valid args", () => {
    expect(parseMode(["bun", "verify-sot", "--mode=host"])).toEqual({ ok: true, mode: "host" });
    expect(parseMode(["bun", "verify-sot", "--mode=vps"])).toEqual({ ok: true, mode: "vps" });
});

test("parseMode rejects missing modes", () => {
    const r = parseMode(["bun", "verify-sot"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("required");
});

test("parseMode rejects unknown modes", () => {
    const r = parseMode(["bun", "verify-sot", "--mode=bogus"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown mode");
});
