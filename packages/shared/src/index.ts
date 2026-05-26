// SPDX-License-Identifier: AGPL-3.0-only

export const ADMIN_ROLES = ["owner", "admin", "operator", "viewer"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const USER_STATUSES = ["active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const PROXY_ACCOUNT_STATUSES = ["active", "disabled", "expired"] as const;
export type ProxyAccountStatus = (typeof PROXY_ACCOUNT_STATUSES)[number];

export const PROTOCOL_KEYS = ["vless_reality"] as const;
export type ProtocolKey = (typeof PROTOCOL_KEYS)[number];

export interface AdminUser {
  id: string;
  email: string;
  username: string;
  name: string;
  role: AdminRole;
  status: UserStatus;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  disabledAt: string | null;
}

export interface ProxyAccount {
  id: string;
  username: string;
  label: string | null;
  status: ProxyAccountStatus;
  enabled: boolean;
  clientDefaultLocalPort: number;
  enabledProtocols: ProtocolKey[];
  expiresAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  previousUuidValidUntil: string | null;
  subscriptionUrlMasked: string | null;
}

export interface ProxyAccountSecretView extends ProxyAccount {
  uuid: string;
  subscriptionUrl: string | null;
}

export interface ServerSettings {
  domain: string;
  panelDomain: string;
  acmeEmail: string;
  acmeDirectory: string;
  antiTrackingHideIp: boolean;
  antiTrackingHideVia: boolean;
  antiTrackingProbeResistance: boolean;
  antiTrackingDohResolver: string;
  http3Enabled: boolean;
  realityPublicKey: string;
  realityDestHost: string;
  realityShortIds: string[];
  lastCaddyfileHash: string | null;
  lastRenderedAt: string | null;
  updatedAt: string;
}

export interface AuditEntry {
  id: number;
  action: string;
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  detail: string | null;
  createdAt: string;
}

export interface StatusSummary {
  version: string;
  hasOwner: boolean;
  userCount: number;
  proxyAccountCount: number;
  activeProxyAccountCount: number;
  settingsReady: boolean;
  migration: MigrationStatus;
  services: Array<{ name: string; status: "unknown" | "running" | "stopped" | "degraded"; detail: string }>;
}

export interface MigrationStatus {
  currentVersion: number;
  requiredVersion: number;
  ok: boolean;
  legacyPhpDetected: boolean;
  legacyMigrationAvailable: boolean;
  message: string;
}

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

export const ROLE_RANK: Record<AdminRole, number> = {
  viewer: 10,
  operator: 20,
  admin: 30,
  owner: 40,
};

export type Permission =
  | "dashboard:read"
  | "users:read"
  | "users:create"
  | "users:update"
  | "users:disable"
  | "users:delete"
  | "users:reset-password"
  | "proxy-accounts:read"
  | "proxy-accounts:write"
  | "settings:read"
  | "settings:update"
  | "status:read"
  | "audit:read"
  | "ops:doctor"
  | "ops:render"
  | "ops:restart"
  | "ops:backup"
  | "ops:restore";

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
  if (actor.role === "admin") return target.role !== "owner";
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

export const DEFAULT_PROTOCOL_KEYS: ProtocolKey[] = ["vless_reality"];
export const DEFAULT_REALITY_DEST_HOST = "www.microsoft.com";
export const DEFAULT_ACME_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";
export const DEFAULT_DOH_RESOLVER = "https://dns.alidns.com/dns-query";
export const RELEASE_VERSION = "0.5.3";
export const REQUIRED_SCHEMA_VERSION = 5;
