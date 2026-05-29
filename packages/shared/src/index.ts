// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

export { z };

export const ADMIN_ROLES = ["owner", "admin", "operator", "viewer"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export const AdminRoleSchema = z.enum(ADMIN_ROLES);

export const USER_STATUSES = ["active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const UserStatusSchema = z.enum(USER_STATUSES);

export const PROXY_ACCOUNT_STATUSES = ["active", "disabled", "expired"] as const;
export type ProxyAccountStatus = (typeof PROXY_ACCOUNT_STATUSES)[number];
export const ProxyAccountStatusSchema = z.enum(PROXY_ACCOUNT_STATUSES);

export const PROTOCOL_KEYS = ["vless_reality"] as const;
export type ProtocolKey = (typeof PROTOCOL_KEYS)[number];
export const ProtocolKeySchema = z.enum(PROTOCOL_KEYS);

export const AdminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  username: z.string(),
  name: z.string(),
  role: AdminRoleSchema,
  status: UserStatusSchema,
  mustChangePassword: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastLoginAt: z.string().nullable(),
  disabledAt: z.string().nullable(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const ProxyAccountSchema = z.object({
  id: z.string(),
  username: z.string(),
  label: z.string().nullable(),
  status: ProxyAccountStatusSchema,
  enabled: z.boolean(),
  clientDefaultLocalPort: z.number(),
  enabledProtocols: z.array(ProtocolKeySchema),
  expiresAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  previousUuidValidUntil: z.string().nullable(),
  subscriptionUrlMasked: z.string().nullable(),
});
export type ProxyAccount = z.infer<typeof ProxyAccountSchema>;

// uuid, previousUuid, and subscriptionUrl are only returned to owner/admin;
// the API redacts them for operator/viewer, so the contract treats them as
// optional. previousUuid is the pre-rotation credential, still valid until
// previousUuidValidUntil — the server render emits it as a second VLESS user
// during that grace window so a `regenerate-uuid` doesn't instantly drop
// clients that haven't re-fetched their subscription yet.
export const ProxyAccountSecretViewSchema = ProxyAccountSchema.extend({
  uuid: z.string().optional(),
  previousUuid: z.string().nullable().optional(),
  subscriptionUrl: z.string().nullable().optional(),
});
export type ProxyAccountSecretView = z.infer<typeof ProxyAccountSecretViewSchema>;

export const ServerSettingsSchema = z.object({
  domain: z.string(),
  panelDomain: z.string(),
  acmeEmail: z.string(),
  acmeDirectory: z.string(),
  antiTrackingHideIp: z.boolean(),
  antiTrackingHideVia: z.boolean(),
  antiTrackingProbeResistance: z.boolean(),
  antiTrackingDohResolver: z.string(),
  http3Enabled: z.boolean(),
  realityPublicKey: z.string(),
  realityDestHost: z.string(),
  realityShortIds: z.array(z.string()),
  lastCaddyfileHash: z.string().nullable(),
  lastRenderedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type ServerSettings = z.infer<typeof ServerSettingsSchema>;

export const AuditEntrySchema = z.object({
  id: z.number(),
  action: z.string(),
  actorUserId: z.string().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  detail: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const MigrationStatusSchema = z.object({
  currentVersion: z.number(),
  requiredVersion: z.number(),
  ok: z.boolean(),
  message: z.string(),
});
export type MigrationStatus = z.infer<typeof MigrationStatusSchema>;

export const StatusSummarySchema = z.object({
  version: z.string(),
  hasOwner: z.boolean(),
  userCount: z.number(),
  proxyAccountCount: z.number(),
  activeProxyAccountCount: z.number(),
  settingsReady: z.boolean(),
  migration: MigrationStatusSchema,
  services: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["unknown", "running", "stopped", "degraded"]),
      detail: z.string(),
    }),
  ),
});
export type StatusSummary = z.infer<typeof StatusSummarySchema>;

export interface ApiErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    retrySafe: boolean;
    next?: string;
  };
}

export type ApiOk<T extends object = Record<string, never>> = { ok: true } & T;

export const PERMISSIONS = [
  "dashboard:read",
  "users:read",
  "users:create",
  "users:update",
  "users:disable",
  "users:delete",
  "users:reset-password",
  "proxy-accounts:read",
  "proxy-accounts:write",
  "settings:read",
  "settings:update",
  "status:read",
  "audit:read",
  "ops:doctor",
  "ops:render",
  "ops:restart",
  "ops:backup",
  "ops:restore",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const PermissionSchema = z.enum(PERMISSIONS);

export const ROLE_RANK: Record<AdminRole, number> = {
  viewer: 10,
  operator: 20,
  admin: 30,
  owner: 40,
};

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  owner: [
    "dashboard:read",
    "users:read",
    "users:create",
    "users:update",
    "users:disable",
    "users:delete",
    "users:reset-password",
    "proxy-accounts:read",
    "proxy-accounts:write",
    "settings:read",
    "settings:update",
    "status:read",
    "audit:read",
    "ops:doctor",
    "ops:render",
    "ops:restart",
    "ops:backup",
    "ops:restore",
  ],
  admin: [
    "dashboard:read",
    "users:read",
    "users:create",
    "users:update",
    "users:disable",
    "users:reset-password",
    "proxy-accounts:read",
    "proxy-accounts:write",
    "settings:read",
    "status:read",
    "audit:read",
    "ops:doctor",
    "ops:render",
    "ops:restart",
    "ops:backup",
  ],
  operator: [
    "dashboard:read",
    "proxy-accounts:read",
    "settings:read",
    "status:read",
    "audit:read",
    "ops:doctor",
    "ops:render",
    "ops:restart",
  ],
  viewer: ["dashboard:read", "proxy-accounts:read", "settings:read", "status:read", "audit:read"],
};

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === "string" && (ADMIN_ROLES as readonly string[]).includes(value);
}

export function requireRole(value: unknown): AdminRole {
  if (!isAdminRole(value)) throw new Error(`invalid role: ${String(value)}`);
  return value;
}

export function hasPermission(user: Pick<AdminUser, "role" | "status">, permission: Permission): boolean {
  if (user.status !== "active") return false;
  return ROLE_PERMISSIONS[user.role].includes(permission);
}

export function roleAtLeast(actual: AdminRole, minimum: AdminRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[minimum];
}

export function canManageTarget(actor: Pick<AdminUser, "role">, target: Pick<AdminUser, "role">): boolean {
  if (actor.role === "owner") return true;
  // Admins may manage only ranks strictly below admin (operator/viewer) — never
  // a peer admin or an owner. This prevents one admin from disabling, demoting,
  // or resetting the password of another admin (lateral takeover / lockout) and
  // keeps management consistent with canCreateRole/canDeleteRole.
  if (actor.role === "admin") return ROLE_RANK[target.role] < ROLE_RANK.admin;
  return false;
}

export function canCreateRole(actor: AdminRole, target: AdminRole): boolean {
  if (actor === "owner") return true;
  if (actor !== "admin") return false;
  return target === "operator" || target === "viewer";
}

export function canDeleteRole(actor: AdminRole, target: AdminRole): boolean {
  if (actor === "owner") return true;
  if (actor !== "admin") return false;
  return target === "operator" || target === "viewer";
}

export function roleLabel(role: AdminRole): string {
  switch (role) {
    case "owner": return "Owner";
    case "admin": return "Admin";
    case "operator": return "Operator";
    case "viewer": return "Viewer";
  }
}

// Response envelopes returned by the admin API. These are the single source of
// truth for the client<->server contract: the API validates outgoing payloads
// against them and the web client parses responses with them, so drift on
// either side fails loudly instead of silently corrupting data.
// The /api/me user is the active session principal, a subset of AdminUser
// (no audit timestamps). Kept separate so the contract matches what the API
// actually returns rather than the fuller AdminUser record.
export const SessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  username: z.string(),
  name: z.string(),
  role: AdminRoleSchema,
  status: UserStatusSchema,
  mustChangePassword: z.boolean(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const MeResponseSchema = z.object({
  user: SessionUserSchema,
  permissions: z.array(PermissionSchema),
  csrfToken: z.string(),
});
export const UsersResponseSchema = z.object({ users: z.array(AdminUserSchema) });
export const UserResponseSchema = z.object({ user: AdminUserSchema });
export const ProxyAccountsResponseSchema = z.object({ accounts: z.array(ProxyAccountSchema) });
export const ProxyAccountResponseSchema = z.object({ account: ProxyAccountSecretViewSchema });
export const SettingsResponseSchema = z.object({ settings: ServerSettingsSchema });
export const StatusResponseSchema = z.object({ status: StatusSummarySchema });
export const AuditResponseSchema = z.object({ audit: z.array(AuditEntrySchema) });

export const DEFAULT_PROTOCOL_KEYS: ProtocolKey[] = ["vless_reality"];
export const DEFAULT_REALITY_DEST_HOST = "www.microsoft.com";
export const DEFAULT_ACME_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";
export const DEFAULT_DOH_RESOLVER = "https://dns.alidns.com/dns-query";
export const RELEASE_VERSION = "0.6.0";
export const REQUIRED_SCHEMA_VERSION = 5;
