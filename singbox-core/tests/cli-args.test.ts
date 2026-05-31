// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/tests/cli-args.test.ts — subcommand parser contracts.

import { expect, test } from "bun:test";
import { parseArgs as parseInstallArgs } from "../src/subcommands/install.ts";
import { parseArgs as parseRenderClientArgs } from "../src/subcommands/render-client.ts";
import { parseArgs as parseRenderServerArgs } from "../src/subcommands/render-server.ts";
import { parseArgs as parseSuperviseArgs } from "../src/subcommands/supervise.ts";

test("render --json requires an output path", () => {
  expect(() => parseRenderServerArgs(["--json"])).toThrow(/requires --output/);
  expect(() => parseRenderClientArgs(["--json"])).toThrow(/requires --output/);
  expect(parseRenderServerArgs(["--json", "--help"]).help).toBe(true);
  expect(parseRenderClientArgs(["--json", "--help"]).help).toBe(true);
});

test("value-taking flags reject missing values", () => {
  expect(() => parseInstallArgs(["--target-dir"])).toThrow(/requires a value/);
  expect(() => parseRenderServerArgs(["--input", "--output", "/tmp/out.json"])).toThrow(
    /requires a value/,
  );
  expect(() => parseSuperviseArgs(["--config"])).toThrow(/requires a value/);
});

test("supervise validates numeric flags before boot", () => {
  expect(() => parseSuperviseArgs(["--healthz-port", "65536"])).toThrow(/between 1 and 65535/);
  expect(() => parseSuperviseArgs(["--boot-timeout-ms", "0"])).toThrow(/>= 1/);

  const parsed = parseSuperviseArgs([
    "--config",
    "/data/config.json",
    "--healthz-port",
    "9091",
    "--boot-timeout-ms",
    "1000",
  ]);
  expect(parsed.config).toBe("/data/config.json");
  expect(parsed.healthzPort).toBe(9091);
  expect(parsed.bootTimeoutMs).toBe(1000);
});
