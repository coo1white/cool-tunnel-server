// SPDX-License-Identifier: AGPL-3.0-only
//
// Prisma client wrapper for cool-tunnel admin DB.
//
// Why Prisma alongside (NOT replacing) AdminStore — Learning #7+#9, v0.8.0:
//   - `AdminStore` (./store.ts) is the audited write path. Every
//     security-relevant mutation (user create / role change / proxy
//     UUID rotation / 2FA secret writes) goes through it. The hand-
//     written SQL is reviewable in one place; the `assertLastOwnerPreserved`
//     and `canManageTarget` checks live at the store layer.
//   - Prisma is the type-safe READ path for NEW features where ergonomics
//     matter more than write-side audit (e.g., /me/sessions listing the
//     current user's active sessions — added in v0.8.0).
//
// Both clients hit the same SQLite file. The schema is introspected from
// the live DB into prisma/schema.prisma; the canonical schema definition
// lives in migrations.ts. To regenerate after a schema bump:
//   DATABASE_URL=file:/tmp/ct-prisma.db pnpm --filter @cool-tunnel/db exec prisma db pull
//   pnpm --filter @cool-tunnel/db exec prisma generate
//
// SQLite stays — not Postgres. See Learning:-09-prisma-ux for the
// "no PG, no AdminStore replacement" decisions.
//
// Driver adapter selection: Prisma 7 requires the driver-adapter pattern.
// We use libsql (Turso's SQLite fork) because:
//   - admin-api runs under Bun, and better-sqlite3's native bindings
//     don't yet work in Bun (oven-sh/bun#4290)
//   - libsql speaks the same SQLite file format as bun:sqlite (used by
//     AdminStore) so the two clients open the same physical .db file
//   - Pure-JS driver under the hood — no native build required at
//     install time

import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "@prisma/client";

let cached: PrismaClient | undefined;

/**
 * Returns a per-process singleton PrismaClient pointed at `dbPath`.
 * In dev (hot-reload) Next.js / Bun re-evaluate this module; the
 * singleton prevents opening a new connection per request.
 */
export function getPrismaClient(dbPath: string): PrismaClient {
  if (cached) return cached;
  const adapter = new PrismaLibSql({ url: `file:${dbPath}` });
  cached = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
  return cached;
}

/**
 * Disconnect the cached client. Tests + graceful-shutdown should call this.
 */
export async function closePrismaClient(): Promise<void> {
  if (cached) {
    await cached.$disconnect();
    cached = undefined;
  }
}
