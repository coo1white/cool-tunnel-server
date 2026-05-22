// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/term.test.ts — terminal helpers (counter shape;
// the actual formatting is exercised via real scripts).

import { test, expect } from "bun:test";
import {
    formatArrowProgress,
    makeTerm,
    terminalDrawBottomLine,
    terminalReserveBottomRow,
    terminalRestoreScrollRegion,
} from "../src/util/term";

test("makeTerm() returns an independent step counter per instance", () => {
    const t1 = makeTerm();
    const t2 = makeTerm();
    const logs1: string[] = [];
    const logs2: string[] = [];
    const origLog = console.log;
    console.log = ((m: string) => {
        if (logs1.length < 3) logs1.push(m);
        else logs2.push(m);
    }) as typeof console.log;
    try {
        t1.step("a");
        t1.step("b");
        t1.step("c");
        t2.step("x");
        t2.step("y");
        t2.step("z");
    } finally {
        console.log = origLog;
    }
    expect(logs1[0]).toContain("1.");
    expect(logs1[1]).toContain("2.");
    expect(logs1[2]).toContain("3.");
    expect(logs2[0]).toContain("1.");
    expect(logs2[1]).toContain("2.");
    expect(logs2[2]).toContain("3.");
});

test("makeTerm({ initialStep }) seeds the counter", () => {
    const t = makeTerm({ initialStep: 10 });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = ((m: string) => logs.push(m)) as typeof console.log;
    try {
        t.step("first after seed");
    } finally {
        console.log = origLog;
    }
    expect(logs[0]).toContain("11.");
});

test("formatArrowProgress renders percent, counts, label, and arrow fill", () => {
    const line = formatArrowProgress({
        label: "ct install",
        current: 6,
        total: 12,
        msg: "Rebuild images",
        width: 100,
    });

    expect(line).toContain("Progress: [ 50%]");
    expect(line).toContain("ct install");
    expect(line).toContain("50%");
    expect(line).toContain("6/12");
    expect(line).toContain("#");
    expect(line).toContain(".");
    expect(line).toContain("Rebuild ima");
});

test("formatArrowProgress clamps long labels to terminal width", () => {
    const line = formatArrowProgress({
        current: 12,
        total: 12,
        msg: "x".repeat(120),
        width: 60,
    });

    expect(line.length).toBeLessThanOrEqual(59);
    expect(line).toContain("100%");
});

test("terminal progress reserves final row like apt/dpkg", () => {
    expect(terminalReserveBottomRow(24)).toBe("\x1b[1;23r\x1b[23;1H");
    expect(terminalDrawBottomLine(24, "Progress")).toBe("\x1b7\x1b[24;1H\x1b[2KProgress\x1b8");
    expect(terminalRestoreScrollRegion(24)).toBe("\x1b7\x1b[24;1H\x1b[2K\x1b8\x1b[r");
});
