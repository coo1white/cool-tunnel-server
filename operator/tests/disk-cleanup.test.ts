// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/disk-cleanup.test.ts — pure safe-cleanup helpers.

import { test, expect } from "bun:test";
import {
    DEFAULT_CLEANUP_COMMANDS,
    cleanupRepoBuildCache,
    describeCleanupDelta,
    formatAutoTempCleanSummary,
    formatCleanupCommand,
    runAutoTempClean,
    type CleanupCommand,
} from "../src/util/disk-cleanup";

const dockerPrune: CleanupCommand = {
    label: "Docker builder cache",
    argv: ["docker", "builder", "prune", "-f"],
};

test("formatCleanupCommand keeps the user-visible command exact", () => {
    expect(formatCleanupCommand(dockerPrune)).toBe("docker builder prune -f");
});

test("default cleanup prunes unused Docker images without touching volumes", () => {
    expect(DEFAULT_CLEANUP_COMMANDS.map(formatCleanupCommand)).toEqual([
        "docker builder prune -f",
        "docker system prune -af",
    ]);
});

test("describeCleanupDelta reports reclaimed headroom when whole-GB free space improves", () => {
    expect(
        describeCleanupDelta(
            { repoGb: 1, dockerGb: 3, dockerRoot: "/var/lib/docker" },
            { repoGb: 2, dockerGb: 5, dockerRoot: "/var/lib/docker" },
        ),
    ).toBe("repo +1G, docker +2G");
});

test("cleanupRepoBuildCache is skipped when repo headroom is already enough", () => {
    const r = cleanupRepoBuildCache(
        { repoGb: 3, dockerGb: 4, dockerRoot: "/var/lib/docker" },
        { minRepoGb: 2, minDockerGb: 4 },
    );
    expect(r).toBeNull();
});

test("runAutoTempClean runs injected safe commands and classifies the final disk state", async () => {
    const measurements = [
        { repoGb: 1, dockerGb: 3, dockerRoot: "/var/lib/docker" },
        { repoGb: 2, dockerGb: 4, dockerRoot: "/var/lib/docker" },
    ];
    const ran: string[] = [];

    const r = await runAutoTempClean({
        thresholds: { minRepoGb: 2, minDockerGb: 4 },
        commands: [dockerPrune],
        cleanRepoCache: () => ({
            label: "Rust build cache",
            action: "ran",
            detail: "removed core/target",
        }),
        measure: async () => measurements.shift()!,
        run: async (cmd) => {
            ran.push(formatCleanupCommand(cmd));
            return { ok: true, code: 0, stdout: "", stderr: "" };
        },
    });

    expect(ran).toEqual(["docker builder prune -f"]);
    expect(r.steps.map((s) => s.label)).toEqual(["Rust build cache", "Docker builder cache"]);
    expect(r.disk.ok).toBe(true);
    expect(formatAutoTempCleanSummary(r)).toContain("temp cleanup complete");
});

test("runAutoTempClean skips cleanup when disk headroom is already good", async () => {
    const ran: string[] = [];
    const r = await runAutoTempClean({
        thresholds: { minRepoGb: 2, minDockerGb: 4 },
        commands: [dockerPrune],
        cleanRepoCache: () => {
            throw new Error("repo cleanup should not run");
        },
        measure: async () => ({ repoGb: 8, dockerGb: 12, dockerRoot: "/var/lib/docker" }),
        run: async (cmd) => {
            ran.push(formatCleanupCommand(cmd));
            return { ok: true, code: 0, stdout: "", stderr: "" };
        },
    });

    expect(ran).toEqual([]);
    expect(r.steps).toEqual([]);
    expect(r.disk.ok).toBe(true);
    expect(formatAutoTempCleanSummary(r)).toContain("no cleanup needed");
});

test("runAutoTempClean can force unused Docker cleanup even with good headroom", async () => {
    const ran: string[] = [];
    const r = await runAutoTempClean({
        thresholds: { minRepoGb: 2, minDockerGb: 4 },
        commands: [dockerPrune],
        cleanRepoCache: () => {
            throw new Error("repo cleanup should not run");
        },
        forceDockerCleanup: true,
        measure: async () => ({ repoGb: 8, dockerGb: 12, dockerRoot: "/var/lib/docker" }),
        run: async (cmd) => {
            ran.push(formatCleanupCommand(cmd));
            return { ok: true, code: 0, stdout: "", stderr: "" };
        },
    });

    expect(ran).toEqual(["docker builder prune -f"]);
    expect(r.steps.map((s) => s.label)).toEqual(["Docker builder cache"]);
    expect(r.disk.ok).toBe(true);
    expect(formatAutoTempCleanSummary(r)).toContain("temp cleanup complete");
});

test("runAutoTempClean preserves the low-disk failure when cleanup is not enough", async () => {
    const r = await runAutoTempClean({
        thresholds: { minRepoGb: 2, minDockerGb: 4 },
        commands: [],
        cleanRepoCache: () => null,
        measure: async () => ({ repoGb: 2, dockerGb: 3, dockerRoot: "/var/lib/docker" }),
    });

    expect(r.disk.ok).toBe(false);
    if (!r.disk.ok) expect(r.disk.failure.summary).toContain("low disk under docker root");
});
