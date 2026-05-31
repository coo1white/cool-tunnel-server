// SPDX-License-Identifier: AGPL-3.0-only
//
// Prisma 7 config. The datasource URL is taken from DATABASE_URL at
// CLI time (for `prisma db pull`, `prisma generate`, etc).
//
// At RUNTIME, the PrismaClient is constructed in src/prisma.ts with an
// explicit URL derived from AdminConfig.dbPath — so the runtime client
// always points at the same SQLite file the rest of the app uses, no
// env-var coordination required.

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./tmp.db",
  },
});
