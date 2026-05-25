// SPDX-License-Identifier: AGPL-3.0-only

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { apiMutation, logout as apiLogout } from "./api";

function value(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function checked(formData: FormData, key: string): boolean {
  return formData.get(key) === "on";
}

export async function logoutAction(): Promise<void> {
  await apiLogout();
}

export async function createUserAction(formData: FormData): Promise<void> {
  const created = await apiMutation<{ user: { id: string } }>("/api/users", {
    email: value(formData, "email"),
    username: value(formData, "username"),
    name: value(formData, "name"),
    password: String(formData.get("password") ?? ""),
    role: value(formData, "role"),
    mustChangePassword: checked(formData, "mustChangePassword"),
  });
  revalidatePath("/users");
  redirect(`/users/${created.user.id}`);
}

export async function updateUserAction(formData: FormData): Promise<void> {
  const id = value(formData, "id");
  await apiMutation(`/api/users/${encodeURIComponent(id)}`, {
    email: value(formData, "email"),
    username: value(formData, "username"),
    name: value(formData, "name"),
    role: value(formData, "role"),
    status: value(formData, "status"),
    mustChangePassword: checked(formData, "mustChangePassword"),
  }, "PATCH");
  revalidatePath("/users");
  revalidatePath(`/users/${id}`);
}

export async function userCommandAction(formData: FormData): Promise<void> {
  const id = value(formData, "id");
  const command = value(formData, "command");
  if (command === "delete") {
    await apiMutation(`/api/users/${encodeURIComponent(id)}`, {}, "DELETE");
    revalidatePath("/users");
    redirect("/users");
  }
  if (command === "reset-password") {
    await apiMutation(`/api/users/${encodeURIComponent(id)}/reset-password`, { password: String(formData.get("password") ?? "") });
  } else {
    await apiMutation(`/api/users/${encodeURIComponent(id)}/${command}`);
  }
  revalidatePath("/users");
  revalidatePath(`/users/${id}`);
}

export async function createProxyAccountAction(formData: FormData): Promise<void> {
  await apiMutation("/api/proxy-accounts", {
    username: value(formData, "username"),
    label: value(formData, "label") || null,
    enabled: checked(formData, "enabled"),
    clientDefaultLocalPort: Number(value(formData, "clientDefaultLocalPort") || "1080"),
    enabledProtocols: ["vless_reality"],
    expiresAt: value(formData, "expiresAt") || null,
  });
  revalidatePath("/users");
}

export async function proxyCommandAction(formData: FormData): Promise<void> {
  const id = value(formData, "id");
  const command = value(formData, "command");
  if (command === "delete") {
    await apiMutation(`/api/proxy-accounts/${encodeURIComponent(id)}`, {}, "DELETE");
  } else {
    await apiMutation(`/api/proxy-accounts/${encodeURIComponent(id)}/${command}`);
  }
  revalidatePath("/users");
}

export async function updateSettingsAction(formData: FormData): Promise<void> {
  await apiMutation("/api/settings", {
    domain: value(formData, "domain"),
    panelDomain: value(formData, "panelDomain"),
    acmeEmail: value(formData, "acmeEmail"),
    acmeDirectory: value(formData, "acmeDirectory"),
    antiTrackingHideIp: checked(formData, "antiTrackingHideIp"),
    antiTrackingHideVia: checked(formData, "antiTrackingHideVia"),
    antiTrackingProbeResistance: checked(formData, "antiTrackingProbeResistance"),
    antiTrackingDohResolver: value(formData, "antiTrackingDohResolver"),
    realityDestHost: value(formData, "realityDestHost"),
    realityShortIds: value(formData, "realityShortIds").split(",").map((part) => part.trim()),
  }, "PATCH");
  revalidatePath("/settings");
  revalidatePath("/status");
}

export async function runAction(formData: FormData): Promise<void> {
  const command = value(formData, "command");
  const body = command === "render-caddyfile" ? { target: "caddyfile" } : command === "render-singbox" ? { target: "singbox" } : {};
  const path = command === "doctor" ? "/api/doctor/run" : command.startsWith("render-") ? "/api/render" : `/api/actions/${command}`;
  await apiMutation(path, body);
  revalidatePath("/status");
}
