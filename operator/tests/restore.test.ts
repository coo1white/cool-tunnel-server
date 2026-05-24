// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/restore.test.ts — argv parser for the `restore`
// subcommand. The runRestore() flow itself is integration-only
// (needs docker / a real tarball).

import { test, expect } from "bun:test";
import {
    expectedRestoreVolumes,
    parseRestoreArgs,
    restoreDatabaseImportFailureHint,
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
        "admin_data.tgz",
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
    expect(expectedRestoreVolumes("cool-tunnel-server")).toContain("cool-tunnel-server_admin_data");
    expect(staleVolumeNames([
        "cool-tunnel-server_db_data",
        "cool-tunnel-server_admin_data",
        "cool-tunnel-server_caddy_data",
        "other_db_data",
        "cool-tunnel-server_unrelated",
    ], "cool-tunnel-server")).toEqual([
        "cool-tunnel-server_admin_data",
        "cool-tunnel-server_caddy_data",
        "cool-tunnel-server_db_data",
    ]);
});

test("restore task requires and restores Better Auth admin_data volume", async () => {
    const body = await Bun.file("./restore.ts").text();

    expect(body).toContain('requireRestoredPath(`${restoreDir}/admin_data.tgz`, "admin_data.tgz")');
    expect(body).toContain("Restore admin_data volume from admin_data.tgz");
    expect(body).toContain("${project}_admin_data");
});

test("restoreDatabaseImportFailureHint explains MariaDB auth failures", () => {
    const hint = restoreDatabaseImportFailureHint("ERROR 1045 (28000): Access denied for user 'root'");

    expect(hint).toContain("DB_ROOT_PASSWORD");
    expect(hint).toContain("restored .env");
});

test("restoreDatabaseImportFailureHint explains missing restored database", () => {
    const hint = restoreDatabaseImportFailureHint("ERROR 1049 (42000): Unknown database 'cooltunnel'");

    expect(hint).toContain("DB_DATABASE");
    expect(hint).toContain("docker compose logs --tail=80 db");
});

test("restoreDatabaseImportFailureHint explains rejected SQL dump", () => {
    const hint = restoreDatabaseImportFailureHint("ERROR 1064 (42000): You have an error in your SQL syntax");

    expect(hint).toContain("db.sql");
    expect(hint).toContain("corrupt");
});
