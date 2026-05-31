// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, RunContext } from "../src/runner/context";
import { AdminTask } from "../src/tasks/admin";

const SECRET = "test-better-auth-secret-".padEnd(43, "x");

function baseEnv(dbPath: string, args: string[]): Record<string, string> {
  return {
    _CT_OPERATOR_ADMIN_ARGS: args.join("\n"),
    CT_ADMIN_ENV: "test",
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: "https://panel.example.com",
    CT_ADMIN_DB_PATH: dbPath,
    DOMAIN: "proxy.example.com",
    PANEL_DOMAIN: "panel.example.com",
    ACME_EMAIL: "ops@example.com",
    REALITY_PRIVATE_KEY: "A".repeat(43),
    REALITY_PUBLIC_KEY: "B".repeat(43),
  };
}

function testContext(dir: string, args: string[]) {
  const logs: Array<{ level: keyof Logger; msg: string }> = [];
  const logger: Logger = {
    info: (msg) => logs.push({ level: "info", msg }),
    warn: (msg) => logs.push({ level: "warn", msg }),
    error: (msg) => logs.push({ level: "error", msg }),
    debug: (msg) => logs.push({ level: "debug", msg }),
  };
  const dbPath = join(dir, "admin.sqlite");
  const ctx: RunContext = {
    cwd: dir,
    env: baseEnv(dbPath, args),
    logger,
    json: false,
    interactive: false,
  };
  return { ctx, logs, dbPath };
}

test("admin bootstrap writes one-time setup material to a root-only file and redacts logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-operator-admin-"));
  try {
    const { ctx, logs } = testContext(dir, ["bootstrap", "--ttl-minutes", "10"]);
    const result = await new AdminTask().run(ctx);
    expect(result.ok).toBe(true);

    const materialPath = join(dir, "bootstrap-setup-url.txt");
    expect(statSync(materialPath).mode & 0o777).toBe(0o600);
    const body = readFileSync(materialPath, "utf8");
    expect(body).toContain("setup_url=https://panel.example.com/setup?token=ctbt_");
    expect(body).toContain("token=ctbt_");
    expect(body).toContain("expires_at=");

    const logText = logs.map((entry) => entry.msg).join("\n");
    expect(logText).toContain(`Setup material written: ${materialPath}`);
    expect(logText).toContain("Setup URL: https://panel.example.com/setup?token=<redacted>");
    expect(logText).not.toContain("ctbt_");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin create-owner uses SQLite store and does not log the supplied password", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-operator-admin-"));
  try {
    const password = "correct horse battery staple";
    const { ctx, logs } = testContext(dir, [
      "create-owner",
      "--email",
      "owner@example.com",
      "--username",
      "owner",
      "--password-stdin",
    ]);
    ctx.env.CT_ADMIN_PASSWORD = password;
    const result = await new AdminTask().run(ctx);
    expect(result.ok).toBe(true);
    expect(logs.map((entry) => entry.msg).join("\n")).not.toContain(password);

    const listed = testContext(dir, ["users", "list"]);
    const listResult = await new AdminTask().run(listed.ctx);
    expect(listResult.ok).toBe(true);
    expect(listed.logs.map((entry) => entry.msg).join("\n")).toContain(
      "owner\towner@example.com\towner\tactive",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin serve is disabled in the operator CLI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-operator-admin-"));
  try {
    const { ctx, logs } = testContext(dir, ["serve"]);
    const result = await new AdminTask().run(ctx);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
    expect(logs.map((entry) => entry.msg).join("\n")).toContain("ct admin serve was removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
