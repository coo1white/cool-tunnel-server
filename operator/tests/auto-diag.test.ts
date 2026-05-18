// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/auto-diag.test.ts — parser and summary helpers.

import { expect, test } from "bun:test";
import { parseAutoDiagArgs, reportPathFor, summarizeSections, type AutoDiagSection } from "../src/tasks/auto-diag";

test("parseAutoDiagArgs defaults to logs with a 120-line tail", () => {
    const r = parseAutoDiagArgs(["bun", "operator", "auto-diag"]);
    expect(typeof r).toBe("object");
    if (typeof r !== "object") return;
    expect(r.includeLogs).toBe(true);
    expect(r.tail).toBe(120);
});

test("parseAutoDiagArgs accepts --tail and --no-logs", () => {
    const r = parseAutoDiagArgs(["bun", "operator", "auto-diag", "--tail", "25", "--no-logs"]);
    expect(typeof r).toBe("object");
    if (typeof r !== "object") return;
    expect(r.includeLogs).toBe(false);
    expect(r.tail).toBe(25);
});

test("parseAutoDiagArgs accepts --tail=N and ignores operator-global flags", () => {
    const r = parseAutoDiagArgs(["bun", "operator", "auto-diag", "--json", "--tail=7", "--no-bridge"]);
    expect(typeof r).toBe("object");
    if (typeof r !== "object") return;
    expect(r.tail).toBe(7);
});

test("parseAutoDiagArgs rejects bad flags and bad tail values", () => {
    expect(parseAutoDiagArgs(["bun", "operator", "auto-diag", "--bogus"])).toContain("unknown flag");
    expect(parseAutoDiagArgs(["bun", "operator", "auto-diag", "--tail", "x"])).toContain("between");
    expect(parseAutoDiagArgs(["bun", "operator", "auto-diag", "--tail"])).toContain("requires");
});

test("reportPathFor uses diagnostics directory and filesystem-safe UTC stamp", () => {
    const p = reportPathFor(new Date("2026-05-19T01:02:03Z"));
    expect(p).toBe("diagnostics/ct-auto-diag-2026-05-19T01-02-03Z.txt");
});

test("summarizeSections counts failing sections", () => {
    const sections: AutoDiagSection[] = [
        { title: "a", command: "true", ok: true, code: 0, duration_ms: 1, output: "" },
        { title: "b", command: "false", ok: false, code: 1, duration_ms: 2, output: "no" },
    ];
    expect(summarizeSections(sections)).toEqual({ ok: false, passed: 1, failed: 1 });
});
