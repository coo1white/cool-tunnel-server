// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/auto-update.test.ts — argv parser for the
// `auto-update` subcommand.

import { expect, test } from "bun:test";
import { parseAutoUpdateArgs } from "../auto-update";

test("parseAutoUpdateArgs: defaults to interactive + non-dry", () => {
  const r = parseAutoUpdateArgs(["bun", "operator", "auto-update"]);
  expect(typeof r).toBe("object");
  if (typeof r !== "object") return;
  expect(r.quiet).toBe(false);
  expect(r.dryRun).toBe(false);
});

test("parseAutoUpdateArgs: --quiet enables quiet mode", () => {
  const r = parseAutoUpdateArgs(["bun", "operator", "auto-update", "--quiet"]);
  if (typeof r !== "object") throw new Error("expected object");
  expect(r.quiet).toBe(true);
  expect(r.dryRun).toBe(false);
});

test("parseAutoUpdateArgs: short form -q + -n combine", () => {
  const r = parseAutoUpdateArgs(["bun", "operator", "auto-update", "-q", "-n"]);
  if (typeof r !== "object") throw new Error("expected object");
  expect(r.quiet).toBe(true);
  expect(r.dryRun).toBe(true);
});

test("parseAutoUpdateArgs: ignores operator-global --json", () => {
  const r = parseAutoUpdateArgs(["bun", "operator", "auto-update", "--json", "--dry-run"]);
  if (typeof r !== "object") throw new Error("expected object");
  expect(r.dryRun).toBe(true);
});

test("parseAutoUpdateArgs: rejects unknown flags", () => {
  const r = parseAutoUpdateArgs(["bun", "operator", "auto-update", "--bogus"]);
  expect(typeof r).toBe("string");
  expect(r as string).toContain("unknown flag");
});
