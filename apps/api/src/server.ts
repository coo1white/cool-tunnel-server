#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only

import { loadAdminConfig } from "@cool-tunnel/config";
import { AdminStore, migrateAdminDb, openAdminDb } from "@cool-tunnel/db";
import { redactSensitive } from "@cool-tunnel/security";
import { createAuth } from "./auth";
import { createApiApp } from "./app";

export async function serveAdminApi(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = loadAdminConfig(env);
  const { db } = openAdminDb(config.dbPath);
  migrateAdminDb(db);
  const store = new AdminStore(db, config);
  store.ensureDefaults(config);
  const auth = createAuth(config);
  const { app } = createApiApp({ config, store, auth });
  Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: app.fetch,
  });
  process.stderr.write(redactSensitive(`ct admin API listening on ${config.host}:${config.port}\n`));
}

if (import.meta.main) {
  await serveAdminApi();
}
