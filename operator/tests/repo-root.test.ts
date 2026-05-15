// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/repo-root.test.ts — pure-logic tests for
// operator/src/util/repo-root.ts. The actual chdir side-effect is
// exercised in dev mode every time bun runs the suite.

import { test, expect } from "bun:test";
import { isBunFsUrl, ensureRepoRoot } from "../src/util/repo-root";

test("isBunFsUrl: real file:// URL → false (dev mode)", () => {
    expect(isBunFsUrl("file:///Users/me/repo/operator/update.ts")).toBe(false);
});

test("isBunFsUrl: $bunfs URL → true (compiled binary)", () => {
    expect(isBunFsUrl("file:///$bunfs/root/operator/update.ts")).toBe(true);
});

test("isBunFsUrl: bun:// scheme without $bunfs → false (false positive guard)", () => {
    expect(isBunFsUrl("bun://something/else")).toBe(false);
});

test("isBunFsUrl: $bunfs as a substring anywhere → true", () => {
    // The marker appears in the path component; substring match is
    // intentional so future Bun layout changes (e.g. /$bunfs2/) don't
    // silently slip through.
    expect(isBunFsUrl("file:///deeply/nested/$bunfs/path")).toBe(true);
});

test("ensureRepoRoot: with $bunfs URL → does NOT chdir (trusts cwd)", () => {
    const cwdBefore = process.cwd();
    ensureRepoRoot("file:///$bunfs/operator/update.ts");
    expect(process.cwd()).toBe(cwdBefore);
});

test("ensureRepoRoot: with dev-mode URL → chdir's to the URL's parent dir", () => {
    // Use this test file's own URL as the input.
    // `new URL("..", file:///<...>/operator/tests/repo-root.test.ts)`
    // resolves to `file:///<...>/operator/` — one level above the
    // directory containing the resource. After ensureRepoRoot
    // process.cwd() should end with `/operator` regardless of
    // where the test runner was invoked from.
    const cwdBefore = process.cwd();
    try {
        ensureRepoRoot(import.meta.url);
        expect(process.cwd().endsWith("/operator")).toBe(true);
    } finally {
        process.chdir(cwdBefore);
    }
});
