// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/compose.test.ts — pure helpers in
// operator/src/util/compose.ts (the bits that don't need docker).

import { test, expect } from "bun:test";
import { basenameProjectName } from "../src/util/compose";

test("basenameProjectName lowercases", () => {
    expect(basenameProjectName("/opt/Cool-Tunnel-Server")).toBe("cool-tunnel-server");
});

test("basenameProjectName strips non-alphanumerics (compose v2 rule)", () => {
    expect(basenameProjectName("/opt/my.proj@host")).toBe("myprojhost");
});

test("basenameProjectName preserves underscore + dash + digits", () => {
    expect(basenameProjectName("/opt/ct_prod-2026")).toBe("ct_prod-2026");
});

test("basenameProjectName handles trailing slashes", () => {
    expect(basenameProjectName("/opt/cool-tunnel-server/")).toBe("cool-tunnel-server");
    expect(basenameProjectName("/opt/cool-tunnel-server////")).toBe("cool-tunnel-server");
});

test("basenameProjectName with no parent dir uses the whole string", () => {
    expect(basenameProjectName("cool-tunnel-server")).toBe("cool-tunnel-server");
});
