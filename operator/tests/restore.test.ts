// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/restore.test.ts — argv parser for the `restore`
// subcommand. The runRestore() flow itself is integration-only
// (needs docker / a real tarball).

import { test, expect } from "bun:test";
import { parseRestoreArgs } from "../restore";

test("parseRestoreArgs accepts a single positional path", () => {
    const r = parseRestoreArgs(["bun", "operator", "restore", "backups/x.tar.gz"]);
    expect(typeof r).toBe("object");
    if (typeof r !== "object") return;
    expect(r.path).toBe("backups/x.tar.gz");
});

test("parseRestoreArgs filters operator-global flags from the args", () => {
    const r = parseRestoreArgs([
        "bun",
        "operator",
        "restore",
        "--json",
        "backups/x.tar.gz",
    ]);
    expect(typeof r).toBe("object");
    if (typeof r !== "object") return;
    expect(r.path).toBe("backups/x.tar.gz");
});

test("parseRestoreArgs rejects a missing path", () => {
    const r = parseRestoreArgs(["bun", "operator", "restore"]);
    expect(typeof r).toBe("string");
    expect(r as string).toContain("usage:");
});

test("parseRestoreArgs rejects extra positional args", () => {
    const r = parseRestoreArgs(["bun", "operator", "restore", "a.tar.gz", "b.tar.gz"]);
    expect(typeof r).toBe("string");
    expect(r as string).toContain("exactly one");
});
