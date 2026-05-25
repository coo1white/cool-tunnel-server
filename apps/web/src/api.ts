// SPDX-License-Identifier: AGPL-3.0-only

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type {
  AdminUser,
  AuditEntry,
  Permission,
  ProxyAccount,
  ProxyAccountSecretView,
  ServerSettings,
  StatusSummary,
} from "@cool-tunnel/shared";

export interface ApiSession {
  user: AdminUser;
  permissions: Permission[];
  csrfToken: string;
}

export interface ActionState {
  ok: boolean;
  message: string;
}

const apiOrigin = process.env.CT_API_INTERNAL_ORIGIN ?? "http://127.0.0.1:9000";

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const requestHeaders = new Headers(init.headers);
  if (cookieHeader) requestHeaders.set("cookie", cookieHeader);
  requestHeaders.set("accept", "application/json");
  if (init.body && !requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json");
  const response = await fetch(`${apiOrigin}${path}`, {
    ...init,
    headers: requestHeaders,
    cache: "no-store",
  });
  if (response.status === 401) redirect("/login");
  const text = await response.text();
  const data = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok || data.ok === false) {
    const err = data.error as { message?: string; code?: string } | undefined;
    throw new Error(err?.message ?? `Request failed: ${response.status}`);
  }
  return data as T;
}

export async function getSession(): Promise<ApiSession> {
  const data = await apiFetch<{ user: AdminUser; permissions: Permission[]; csrfToken: string }>("/api/me");
  return data;
}

export async function getOptionalSession(): Promise<ApiSession | null> {
  try {
    return await getSession();
  } catch {
    return null;
  }
}

export async function apiMutation<T>(path: string, body: Record<string, unknown> = {}, method = "POST"): Promise<T> {
  const session = await getSession();
  return apiFetch<T>(path, {
    method,
    headers: { "x-csrf-token": session.csrfToken, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function listUsers(): Promise<AdminUser[]> {
  return (await apiFetch<{ users: AdminUser[] }>("/api/users")).users;
}

export async function getUser(id: string): Promise<AdminUser> {
  return (await apiFetch<{ user: AdminUser }>(`/api/users/${encodeURIComponent(id)}`)).user;
}

export async function listProxyAccounts(): Promise<ProxyAccount[]> {
  return (await apiFetch<{ accounts: ProxyAccount[] }>("/api/proxy-accounts")).accounts;
}

export async function getProxyAccount(id: string): Promise<ProxyAccountSecretView> {
  return (await apiFetch<{ account: ProxyAccountSecretView }>(`/api/proxy-accounts/${encodeURIComponent(id)}`)).account;
}

export async function getSettings(): Promise<ServerSettings> {
  return (await apiFetch<{ settings: ServerSettings }>("/api/settings")).settings;
}

export async function getStatus(): Promise<StatusSummary> {
  return (await apiFetch<{ status: StatusSummary }>("/api/status")).status;
}

export async function listAudit(): Promise<AuditEntry[]> {
  return (await apiFetch<{ audit: AuditEntry[] }>("/api/audit")).audit;
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

export async function getForwardedError(): Promise<string> {
  const h = await headers();
  return h.get("x-action-error") ?? "";
}

export function has(permission: Permission, session: ApiSession): boolean {
  return session.permissions.includes(permission);
}

export function stateError(error: unknown): ActionState {
  return { ok: false, message: error instanceof Error ? error.message : "Action failed." };
}
