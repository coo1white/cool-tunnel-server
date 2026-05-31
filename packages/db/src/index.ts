// SPDX-License-Identifier: AGPL-3.0-only

export { StoreError } from "./errors.ts";
export type { AdminDb } from "./migrations.ts";
export { backupAdminSqlite, migrateAdminDb, openAdminDb } from "./migrations.ts";
export { AdminStore } from "./store.ts";
// Prisma client lives behind the @cool-tunnel/db/prisma subpath
// (NOT this barrel) so consumers that don't need it — like the
// operator CLI bundled with `bun build --compile` — don't pull
// Prisma's runtime into their binary. See packages/db/package.json
// exports map.
export type {
  CreateProxyAccountInput,
  CreateUserInput,
  UpdateProxyAccountInput,
  UpdateUserInput,
} from "./types.ts";
