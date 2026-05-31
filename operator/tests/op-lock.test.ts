// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/op-lock.test.ts — pure-logic tests for the argv
// shape passed to a flock-wrapped self-re-exec.

import { expect, test } from "bun:test";
import { resolveReExecArgs } from "../src/util/op-lock";

test("resolveReExecArgs: dev mode argv → script path + user args", () => {
  // `bun run operator/update.ts update` produces this shape.
  const argv = ["/opt/homebrew/bin/bun", "operator/update.ts", "update"];
  expect(resolveReExecArgs(argv)).toEqual(["operator/update.ts", "update"]);
});

test("resolveReExecArgs: dev mode with extra flags", () => {
  const argv = ["/opt/bin/bun", "operator/update.ts", "update", "--json"];
  expect(resolveReExecArgs(argv)).toEqual(["operator/update.ts", "update", "--json"]);
});

test("resolveReExecArgs: compiled binary argv → drop /$bunfs entry", () => {
  // `./operator/bin/ct-operator-linux-x64 update` in a compiled binary.
  // Bun synthesises argv[1] as the /$bunfs/ virtual path to the
  // embedded entry point; the dispatcher ignores it, but a re-exec
  // that includes it confuses the dispatcher in the child.
  const argv = [
    "/opt/cool-tunnel-server/operator/bin/ct-operator-linux-x64",
    "/$bunfs/root/ct-operator-linux-x64",
    "update",
  ];
  expect(resolveReExecArgs(argv)).toEqual(["update"]);
});

test("resolveReExecArgs: compiled binary with flags + extra args", () => {
  const argv = [
    "/opt/cool-tunnel-server/operator/bin/ct-operator-linux-x64",
    "/$bunfs/root/ct-operator-linux-x64",
    "fix",
    "--auto",
    "--json",
  ];
  expect(resolveReExecArgs(argv)).toEqual(["fix", "--auto", "--json"]);
});

test("resolveReExecArgs: short argv (no args) does not blow up", () => {
  // Defensive: real invocations always have at least argv[0],
  // usually argv[1]. But the function shouldn't crash on the edge.
  expect(resolveReExecArgs(["bin"])).toEqual([]);
  expect(resolveReExecArgs([])).toEqual([]);
});
