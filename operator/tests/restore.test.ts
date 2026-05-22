// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/restore.test.ts — argv parser for the `restore`
// subcommand. The runRestore() flow itself is integration-only
// (needs docker / a real tarball).

import { test, expect } from "bun:test";
import {
    expectedRestoreVolumes,
    parseRestoreArgs,
    staleVolumeNames,
    validateTarEntries,
} from "../restore";

test("parseRestoreArgs accepts a single positional path", () => {
    const r = parseRestoreArgs(["bun", "operator", "restore", "backups/x.tar.gz"]);
    expect(typeof r).toBe("object");
    if (typeof r !== "object") return;
    expect(r.path).toBe("backups/x.tar.gz");
});

test("parseRestoreArgs filters operator-global flags from the args", () => {
    const r = parseRestoreArgs([
        "bun",
        "operator",
        "restore",
        "--json",
        "backups/x.tar.gz",
    ]);
    expect(typeof r).toBe("object");
    if (typeof r !== "object") return;
    expect(r.path).toBe("backups/x.tar.gz");
});

test("parseRestoreArgs rejects a missing path", () => {
    const r = parseRestoreArgs(["bun", "operator", "restore"]);
    expect(typeof r).toBe("string");
    expect(r as string).toContain("usage:");
});

test("parseRestoreArgs rejects extra positional args", () => {
    const r = parseRestoreArgs(["bun", "operator", "restore", "a.tar.gz", "b.tar.gz"]);
    expect(typeof r).toBe("string");
    expect(r as string).toContain("exactly one");
});

test("validateTarEntries accepts normal backup members", () => {
    expect(validateTarEntries([
        ".env",
        "db.sql",
        "manifests/panel.upstream.json",
        "caddy/Caddyfile.tpl",
    ])).toBeNull();
});

test("validateTarEntries rejects traversal and absolute members", () => {
    expect(validateTarEntries(["../.ssh/authorized_keys"])).toContain("escapes");
    expect(validateTarEntries(["manifests/../../.env"])).toContain("escapes");
    expect(validateTarEntries(["/root/.ssh/id_rsa"])).toContain("absolute");
    expect(validateTarEntries(["C:\\Users\\root\\.ssh\\id_rsa"])).toContain("drive-qualified");
});

test("staleVolumeNames reports only restore-owned project volumes", () => {
    expect(expectedRestoreVolumes("cool-tunnel-server")).toContain("cool-tunnel-server_db_data");
    expect(staleVolumeNames([
        "cool-tunnel-server_db_data",
        "cool-tunnel-server_caddy_data",
        "other_db_data",
        "cool-tunnel-server_unrelated",
    ], "cool-tunnel-server")).toEqual([
        "cool-tunnel-server_caddy_data",
        "cool-tunnel-server_db_data",
    ]);
});
