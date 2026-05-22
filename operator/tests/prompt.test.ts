// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/prompt.test.ts — pure parsers for operator/src/util/prompt.ts.

import { test, expect } from "bun:test";
import { formatYnPrompt, parseYn, parseChoice } from "../src/util/prompt";

// ---------- parseYn ----------

test("parseYn: 'y' → yes regardless of default", () => {
    expect(parseYn("y", "n")).toBe("yes");
    expect(parseYn("Y", "n")).toBe("yes");
    expect(parseYn("yes", "n")).toBe("yes");
    expect(parseYn("YES", "n")).toBe("yes");
});

test("parseYn: 'n' → no regardless of default", () => {
    expect(parseYn("n", "y")).toBe("no");
    expect(parseYn("N", "y")).toBe("no");
    expect(parseYn("no", "y")).toBe("no");
    expect(parseYn("NO", "y")).toBe("no");
});

test("parseYn: empty reply uses default", () => {
    expect(parseYn("", "y")).toBe("yes");
    expect(parseYn("", "n")).toBe("no");
    expect(parseYn("   ", "y")).toBe("yes");
});

test("parseYn: garbage → retry", () => {
    expect(parseYn("maybe", "n")).toBe("retry");
    expect(parseYn("123", "y")).toBe("retry");
    expect(parseYn("?", "n")).toBe("retry");
});

test("formatYnPrompt: renders explicit SSH-friendly yes/no instructions", () => {
    const prompt = formatYnPrompt("Continue with this state?", "n");
    expect(prompt).toContain("? Continue with this state?");
    expect(prompt).toContain("Type y or n, then press Enter");
    expect(prompt).toContain("(default: n)");
    expect(prompt).toContain("[y/N]");
    expect(prompt).toEndWith("> ");
});

// ---------- parseChoice ----------

test("parseChoice: exact match returns the key", () => {
    expect(parseChoice("s", ["s", "d", "a"])).toBe("s");
    expect(parseChoice("d", ["s", "d", "a"])).toBe("d");
});

test("parseChoice: case-insensitive against allowed list", () => {
    expect(parseChoice("S", ["s", "d", "a"])).toBe("s");
    expect(parseChoice("D", ["s", "d", "a"])).toBe("d");
});

test("parseChoice: trims whitespace", () => {
    expect(parseChoice("  s  ", ["s", "d", "a"])).toBe("s");
});

test("parseChoice: empty reply with fallback returns fallback", () => {
    expect(parseChoice("", ["s", "d", "a"], "a")).toBe("a");
});

test("parseChoice: empty reply without fallback returns null", () => {
    expect(parseChoice("", ["s", "d", "a"])).toBeNull();
});

test("parseChoice: unknown key returns null", () => {
    expect(parseChoice("x", ["s", "d", "a"])).toBeNull();
    expect(parseChoice("x", ["s", "d", "a"], "a")).toBeNull();
});
