// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/backup.test.ts

import { expect, test } from "bun:test";
import { backupDatabaseFailureHint } from "../backup";

test("backupDatabaseFailureHint explains MariaDB auth failures", () => {
    const hint = backupDatabaseFailureHint("ERROR 1045 (28000): Access denied for user 'root'@'localhost'");

    expect(hint).toContain("DB_ROOT_PASSWORD");
    expect(hint).toContain("docker compose logs --tail=80 db");
});

test("backupDatabaseFailureHint explains missing database failures", () => {
    const hint = backupDatabaseFailureHint("ERROR 1049 (42000): Unknown database 'cooltunnel'");

    expect(hint).toContain("DB_DATABASE");
    expect(hint).toContain("SHOW DATABASES");
});

test("backupDatabaseFailureHint explains DB connectivity failures", () => {
    const hint = backupDatabaseFailureHint("Can't connect to server on 'db' (111 Connection refused)");

    expect(hint).toContain("ct-db is not reachable");
    expect(hint).toContain("docker compose ps db");
});

test("backupDatabaseFailureHint preserves unknown stderr context", () => {
    const hint = backupDatabaseFailureHint("first line\nsecond line\nthird line\nfourth line");

    expect(hint).toBe("first line / second line / third line");
});
