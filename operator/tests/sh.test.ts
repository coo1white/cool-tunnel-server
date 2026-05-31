// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/sh.test.ts

import { expect, test } from "bun:test";
import { ShellError } from "../src/util/sh";

test("ShellError message redacts secret-bearing stderr", () => {
  const err = new ShellError(
    "demo",
    1,
    "",
    "APP_KEY=base64:abcdefghijklmnop1234567890ABCDEFGHIJKLMNOP== https://panel.example.com/api/v1/subscription/abcDEF_123-xyz",
  );

  expect(err.message).toContain("APP_KEY=<redacted>");
  expect(err.message).toContain("/api/v1/subscription/<redacted>");
  expect(err.message).not.toContain("abcDEF_123-xyz");
});
