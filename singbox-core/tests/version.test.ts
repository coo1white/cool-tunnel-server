// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/tests/version.test.ts — release asset pin coverage.

import { expect, test } from "bun:test";
import { SINGBOX_UPSTREAM } from "../src/version.ts";

test("server linux assets are pinned for x64 and arm64 release builds", () => {
  expect(SINGBOX_UPSTREAM.assets["linux-amd64"]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(SINGBOX_UPSTREAM.assets["linux-arm64"]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(SINGBOX_UPSTREAM.assets["linux-arm64"]?.url).toContain("linux-arm64.tar.gz");
});
