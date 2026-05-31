// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/tests/argv.test.ts — strict argv helper coverage.

import { expect, test } from "bun:test";
import { flagValue, integerFlagValue } from "../src/util/argv.ts";

test("flagValue returns the following value", () => {
  expect(flagValue(["--config", "/data/config.json"], 0, "--config")).toBe("/data/config.json");
});

test("flagValue rejects missing values and flag-shaped values", () => {
  expect(() => flagValue(["--config"], 0, "--config")).toThrow(/requires a value/);
  expect(() => flagValue(["--config", "--healthz-port"], 0, "--config")).toThrow(
    /requires a value/,
  );
});

test("integerFlagValue validates integer bounds", () => {
  expect(
    integerFlagValue(["--healthz-port", "9091"], 0, "--healthz-port", {
      min: 1,
      max: 65_535,
    }),
  ).toBe(9091);
  expect(() => integerFlagValue(["--healthz-port", "0"], 0, "--healthz-port", { min: 1 })).toThrow(
    />= 1/,
  );
  expect(() =>
    integerFlagValue(["--healthz-port", "nope"], 0, "--healthz-port", { min: 1 }),
  ).toThrow(/integer/);
});
