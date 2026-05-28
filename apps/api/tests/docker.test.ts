// SPDX-License-Identifier: AGPL-3.0-only
// Pure mapping from Docker container State to dashboard service status.

import { test, expect } from "bun:test";
import { mapContainerState } from "../src/docker";

test("running + healthy -> running", () => {
    const r = mapContainerState({ Status: "running", Health: { Status: "healthy" } });
    expect(r.status).toBe("running");
    expect(r.detail).toContain("healthy");
});

test("running without a healthcheck -> running", () => {
    expect(mapContainerState({ Status: "running" }).status).toBe("running");
});

test("running + unhealthy -> degraded", () => {
    expect(mapContainerState({ Status: "running", Health: { Status: "unhealthy" } }).status).toBe("degraded");
});

test("running + starting -> degraded", () => {
    expect(mapContainerState({ Status: "running", Health: { Status: "starting" } }).status).toBe("degraded");
});

test("restarting / paused -> degraded", () => {
    expect(mapContainerState({ Status: "restarting" }).status).toBe("degraded");
    expect(mapContainerState({ Status: "paused" }).status).toBe("degraded");
});

test("exited / dead -> stopped", () => {
    expect(mapContainerState({ Status: "exited" }).status).toBe("stopped");
    expect(mapContainerState({ Status: "dead" }).status).toBe("stopped");
});

test("missing container (null) -> stopped, not found", () => {
    const r = mapContainerState(null);
    expect(r.status).toBe("stopped");
    expect(r.detail).toContain("not found");
});

test("status values stay within the StatusSummary schema enum", () => {
    const allowed = new Set(["unknown", "running", "stopped", "degraded"]);
    for (const state of [
        { Status: "running", Health: { Status: "healthy" } },
        { Status: "running", Health: { Status: "unhealthy" } },
        { Status: "exited" },
        { Status: "paused" },
        null,
    ]) {
        expect(allowed.has(mapContainerState(state).status)).toBe(true);
    }
});
