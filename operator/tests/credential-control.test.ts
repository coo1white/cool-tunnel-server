// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/credential-control.test.ts

import { expect, test } from "bun:test";
import {
    credentialLockCheckCommand,
    readSingboxConfigCommand,
    recreateSingboxCommand,
    renderSingboxConfigCommand,
    restartSingboxCommand,
    singboxLogsCommand,
    SINGBOX_CONFIG_PATH,
    SINGBOX_SERVICE,
} from "../src/util/credential-control";

test("credential control owns current service and config path names", () => {
    expect(SINGBOX_SERVICE).toBe("singbox");
    expect(SINGBOX_CONFIG_PATH).toBe("/data/config/singbox.json");
});

test("credential control uses panel-owned guard and render commands", () => {
    expect(credentialLockCheckCommand()).toEqual([
        "docker", "compose", "exec", "-T", "panel", "php", "artisan", "credential-lock:check",
    ]);
    expect(renderSingboxConfigCommand()).toEqual([
        "docker", "compose", "exec", "-T", "panel", "php", "artisan", "singbox:render", "--if-changed",
    ]);
});

test("credential control uses current singbox service for generated artifacts", () => {
    expect(readSingboxConfigCommand()).toEqual([
        "docker", "compose", "exec", "-T", "panel", "cat", "/data/config/singbox.json",
    ]);
    expect(restartSingboxCommand()).toEqual(["docker", "compose", "restart", "singbox"]);
    expect(recreateSingboxCommand()).toEqual(["docker", "compose", "up", "-d", "singbox"]);
    expect(singboxLogsCommand(20, true)).toEqual([
        "docker", "compose", "logs", "--tail=20", "--no-color", "singbox",
    ]);
});
