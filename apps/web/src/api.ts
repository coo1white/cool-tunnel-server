// SPDX-License-Identifier: AGPL-3.0-only

import type {
  AdminUser,
  AuditEntry,
  Permission,
  ProxyAccount,
  ProxyAccountSecretView,
  ServerSettings,
  SessionUser,
  StatusSummary,
} from "@cool-tunnel/shared";
import {
  AuditResponseSchema,
  MeResponseSchema,
  ProxyAccountResponseSchema,
  ProxyAccountsResponseSchema,
  SettingsResponseSchema,
  StatusResponseSchema,
  UserResponseSchema,
  UsersResponseSchema,
  type z,
} from "@cool-tunnel/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export interface ApiSession {
  user: SessionUser;
  permissions: Permission[];
  csrfToken: string;
}

export interface ActionState {
  ok: boolean;
  message: string;
}

const apiOrigin = process.env.CT_API_INTERNAL_ORIGIN ?? "http://127.0.0.1:9000";

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  schema?: z.ZodType<T>,
): Promise<T> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const requestHeaders = new Headers(init.headers);
  if (cookieHeader) requestHeaders.set("cookie", cookieHeader);
  requestHeaders.set("accept", "application/json");
  if (init.body && !requestHeaders.has("content-type"))
    requestHeaders.set("content-type", "application/json");
  const response = await fetch(`${apiOrigin}${path}`, {
    ...init,
    headers: requestHeaders,
    cache: "no-store",
  });
  if (response.status === 401) redirect("/login");
  const text = await response.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok || data.ok === false) {
    const err = data.error as { message?: string; code?: string } | undefined;
    throw new Error(err?.message ?? `Request failed: ${response.status}`);
  }
  if (!schema) return data as T;
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`API contract mismatch for ${path}: ${detail}`);
  }
  return parsed.data;
}

export async function getSession(): Promise<ApiSession> {
  const data = await apiFetch<{ user: SessionUser; permissions: Permission[]; csrfToken: string }>(
    "/api/me",
    {},
    MeResponseSchema,
  );
  return data;
}

export async function apiMutation<T>(
  path: string,
  body: Record<string, unknown> = {},
  method = "POST",
): Promise<T> {
  const session = await getSession();
  return apiFetch<T>(path, {
    method,
    headers: { "x-csrf-token": session.csrfToken, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function listUsers(): Promise<AdminUser[]> {
  return (await apiFetch<{ users: AdminUser[] }>("/api/users", {}, UsersResponseSchema)).users;
}

export async function getUser(id: string): Promise<AdminUser> {
  return (
    await apiFetch<{ user: AdminUser }>(
      `/api/users/${encodeURIComponent(id)}`,
      {},
      UserResponseSchema,
    )
  ).user;
}

export async function listProxyAccounts(): Promise<ProxyAccount[]> {
  return (
    await apiFetch<{ accounts: ProxyAccount[] }>(
      "/api/proxy-accounts",
      {},
      ProxyAccountsResponseSchema,
    )
  ).accounts;
}

export async function getProxyAccount(id: string): Promise<ProxyAccountSecretView> {
  return (
    await apiFetch<{ account: ProxyAccountSecretView }>(
      `/api/proxy-accounts/${encodeURIComponent(id)}`,
      {},
      ProxyAccountResponseSchema,
    )
  ).account;
}

export async function getSettings(): Promise<ServerSettings> {
  return (await apiFetch<{ settings: ServerSettings }>("/api/settings", {}, SettingsResponseSchema))
    .settings;
}

export async function getStatus(): Promise<StatusSummary> {
  return (await apiFetch<{ status: StatusSummary }>("/api/status", {}, StatusResponseSchema))
    .status;
}

export async function listAudit(): Promise<AuditEntry[]> {
  return (await apiFetch<{ audit: AuditEntry[] }>("/api/audit", {}, AuditResponseSchema)).audit;
}

export async function logout(): Promise<void> {
  const session = await getSession();
  await apiFetch("/api/logout", {
    method: "POST",
    headers: { "x-csrf-token": session.csrfToken, "content-type": "application/json" },
    body: "{}",
  });
  redirect("/login");
}

export function has(permission: Permission, session: ApiSession): boolean {
  return session.permissions.includes(permission);
}

export function stateError(error: unknown): ActionState {
  return { ok: false, message: error instanceof Error ? error.message : "Action failed." };
}
