// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/credential-sync.test.ts — pure helpers in
// operator/src/util/credential-sync.ts.

import { test, expect } from "bun:test";
import { dumpIndented, type SyncLogger } from "../src/util/credential-sync";

function makeLogger(): { info: string[]; err: string[]; raw: string[]; logger: SyncLogger } {
    const info: string[] = [];
    const err: string[] = [];
    const raw: string[] = [];
    return {
        info,
        err,
        raw,
        logger: {
            info: (l) => info.push(l),
            err: (l) => err.push(l),
            raw: (t) => raw.push(t),
        },
    };
}

test("dumpIndented routes to raw() when present", () => {
    const { raw, info, logger } = makeLogger();
    dumpIndented(logger, "first\nsecond\n");
    expect(raw).toEqual(["    first\n    second"]);
    expect(info).toEqual([]);
});

test("dumpIndented falls back to info() when raw() is absent", () => {
    const info: string[] = [];
    dumpIndented({ info: (l) => info.push(l), err: () => {} }, "first\nsecond\n");
    expect(info).toEqual(["    first", "    second"]);
});

test("dumpIndented strips blank lines (matches bash sed behaviour)", () => {
    const { raw, logger } = makeLogger();
    dumpIndented(logger, "first\n\n  \nsecond\n");
    // Blank/whitespace-only lines are dropped before indentation.
    expect(raw).toEqual(["    first\n    second"]);
});

test("dumpIndented on empty input is a no-op", () => {
    const { raw, info, logger } = makeLogger();
    dumpIndented(logger, "");
    expect(raw).toEqual([]);
    expect(info).toEqual([]);
});

test("dumpIndented on whitespace-only input is a no-op", () => {
    const { raw, info, logger } = makeLogger();
    dumpIndented(logger, "   \n\t\n  ");
    expect(raw).toEqual([]);
    expect(info).toEqual([]);
});
