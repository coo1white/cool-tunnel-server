#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
//
// Build-time OpenAPI spec emitter. Loads apps/api with stub config + an
// in-memory store, asks the OpenAPIHono instance to produce its 3.1 doc,
// writes it to disk at <out>.
//
// Why build-time only (and NOT a runtime /openapi.json endpoint):
//   1. The admin-api is admin-only and behind auth on /api/*. The one
//      public route is /api/v1/subscription/:token, designed to be
//      probe-resistant — exposing /openapi.json would leak the API
//      surface to unauthenticated callers, defeating that design.
//   2. Build-time generation lets the spec ship as a release asset,
//      with cosign attestation, alongside the operator binaries.
//      Anyone integrating gets a versioned, signed contract without
//      adding runtime attack surface.
//
// Called from release.yml's openapi-bundle job and from `make openapi`
// locally. Output path is configurable via argv[0]; defaults to
// apps/api/dist/openapi.json.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createApiApp } from "../apps/api/src/app";
import type { AdminConfig } from "../packages/config/src/index";
import { AdminStore, migrateAdminDb, openAdminDb } from "../packages/db/src/index";

function stubConfig(): AdminConfig {
  // Minimal config — values must satisfy the AdminConfig type but
  // never get hit at runtime since we only call getOpenAPI31Document(),
  // not serve. The stub strings are deliberately marked so a grep of
  // the emitted spec immediately flags any leakage (there shouldn't
  // be any — OpenAPI docs are schema-only).
  return {
    appEnv: "production",
    host: "127.0.0.1",
    port: 9000,
    panelDomain: "openapi.example",
    domain: "openapi.example",
    baseUrl: "https://openapi.example",
    trustedOrigins: [],
    authSecret: "openapi-doc-stub-only-not-a-real-secret-0000000000000000",
    dbPath: ":memory:",
    publicSignup: false,
    secureCookies: true,
    bootstrapTokenTtlMinutes: 30,
    caddyfilePath: "/tmp/openapi-stub-caddyfile",
    caddyfileTemplate: "",
    singboxConfigPath: "/tmp/openapi-stub-singbox.json",
    manifestsDir: "/tmp/openapi-stub-manifests",
    acmeEmail: "openapi-doc@example.invalid",
    acmeDirectory: "https://openapi.example/acme",
    realityPrivateKey: "",
    realityPublicKey: "",
    realityDestHost: "",
    realityShortIds: [],
    antiTrackingDohResolver: "",
    version: process.env.npm_package_version ?? "0.0.0",
  };
}

async function main(): Promise<number> {
  const outPath = resolve(process.argv[2] ?? "apps/api/dist/openapi.json");

  const config = stubConfig();
  const adminDb = openAdminDb(":memory:");
  migrateAdminDb(adminDb.db);
  const store = new AdminStore(adminDb.db, config);
  const { app } = createApiApp({ config, store });

  const doc = app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Cool Tunnel Admin API",
      version: config.version,
      description:
        "The cool-tunnel-server admin/control-plane API. Most endpoints are admin-only and session+CSRF gated; the single public endpoint is GET /api/v1/subscription/{token} which returns a signed manifest for a configured proxy account, or the cover-site HTML on miss.",
      license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
    },
    servers: [{ url: "https://{panel}.{domain}", description: "Production admin panel" }],
  });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(`wrote ${outPath}  (${Object.keys(doc.paths ?? {}).length} documented path(s))`);

  adminDb.db.close();
  return 0;
}

const code = await main();
process.exit(code);
