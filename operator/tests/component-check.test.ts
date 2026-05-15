// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/component-check.test.ts — pure NG-row parser.

import { test, expect } from "bun:test";
import { parseNgComponents } from "../src/util/component-check";

test("parseNgComponents: empty input → empty list", () => {
    expect(parseNgComponents("")).toEqual([]);
});

test("parseNgComponents: single NG row extracts the component name", () => {
    const out = `Component check
  OK panel
  NG sing-box  rendered config invalid
  OK haproxy
`;
    expect(parseNgComponents(out)).toEqual(["sing-box"]);
});

test("parseNgComponents: multiple NG rows → sorted, deduped names", () => {
    const out = `  NG panel  octane crash
  NG sing-box  rendered config invalid
  NG panel  duplicate row (e.g. retry attempt)
`;
    expect(parseNgComponents(out)).toEqual(["panel", "sing-box"]);
});

test("parseNgComponents: ignores OK rows + table headers", () => {
    const out = `Status   Component   Detail
OK       panel       ok
OK       sing-box    ok
`;
    expect(parseNgComponents(out)).toEqual([]);
});

test("parseNgComponents: tolerates leading whitespace before NG", () => {
    const out = `    NG  redis  AUTH failure
`;
    expect(parseNgComponents(out)).toEqual(["redis"]);
});

test("parseNgComponents: rejects 'NG' inside larger words", () => {
    const out = `MORNING panel  ok
RINGS sing-box  ok
`;
    expect(parseNgComponents(out)).toEqual([]);
});
