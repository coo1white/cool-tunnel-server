// SPDX-License-Identifier: AGPL-3.0-only
// singbox-core/tests/supervise.test.ts — supervisor watch helpers.

import { test, expect } from "bun:test";
import { isConfigWatchEvent } from "../src/subcommands/supervise.ts";

const CONFIG_PATH = "/data/config/singbox.json";

test("config watcher accepts the final atomic-rename event", () => {
    expect(isConfigWatchEvent(CONFIG_PATH, "singbox.json")).toBe(true);
});

test("config watcher ignores sibling temp-file churn", () => {
    expect(isConfigWatchEvent(CONFIG_PATH, ".singbox-core.tmp.1234abcd")).toBe(false);
});

test("config watcher treats null filenames as relevant", () => {
    expect(isConfigWatchEvent(CONFIG_PATH, null)).toBe(true);
});
