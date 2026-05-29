// SPDX-License-Identifier: AGPL-3.0-only

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { apiMutation, logout as apiLogout, stateError, type ActionState } from "./api";

function value(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function checked(formData: FormData, key: string): boolean {
  return formData.get(key) === "on";
}

export async function logoutAction(): Promise<void> {
  await apiLogout();
}

export async function changePasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const newPassword = String(formData.get("newPassword") ?? "");
  if (newPassword !== String(formData.get("confirmPassword") ?? "")) {
    return { ok: false, message: "New password and confirmation do not match." };
  }
  try {
    await apiMutation("/api/me/password", {
      currentPassword: String(formData.get("currentPassword") ?? ""),
      newPassword,
    });
  } catch (error) {
    return stateError(error);
  }
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function createUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let createdId: string;
  try {
    const created = await apiMutation<{ user: { id: string } }>("/api/users", {
      email: value(formData, "email"),
      username: value(formData, "username"),
      name: value(formData, "name"),
      password: String(formData.get("password") ?? ""),
      role: value(formData, "role"),
      mustChangePassword: checked(formData, "mustChangePassword"),
    });
    createdId = created.user.id;
  } catch (error) {
    return stateError(error);
  }
  revalidatePath("/users");
  redirect(`/users/${createdId}`);
}

export async function updateUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = value(formData, "id");
  try {
    await apiMutation(`/api/users/${encodeURIComponent(id)}`, {
      email: value(formData, "email"),
      username: value(formData, "username"),
      name: value(formData, "name"),
      role: value(formData, "role"),
      status: value(formData, "status"),
      mustChangePassword: checked(formData, "mustChangePassword"),
    }, "PATCH");
  } catch (error) {
    return stateError(error);
  }
  revalidatePath("/users");
  revalidatePath(`/users/${id}`);
  return { ok: true, message: "User updated." };
}

export async function userCommandAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = value(formData, "id");
  const command = value(formData, "command");
  try {
    if (command === "delete") {
      await apiMutation(`/api/users/${encodeURIComponent(id)}`, {}, "DELETE");
    } else if (command === "reset-password") {
      await apiMutation(`/api/users/${encodeURIComponent(id)}/reset-password`, { password: String(formData.get("password") ?? "") });
    } else {
      await apiMutation(`/api/users/${encodeURIComponent(id)}/${command}`);
    }
  } catch (error) {
    return stateError(error);
  }
  revalidatePath("/users");
  revalidatePath(`/users/${id}`);
  if (command === "delete") redirect("/users");
  return { ok: true, message: command === "reset-password" ? "Temporary password set." : "User updated." };
}

export async function createProxyAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    await apiMutation("/api/proxy-accounts", {
      username: value(formData, "username"),
      label: value(formData, "label") || null,
      enabled: checked(formData, "enabled"),
      clientDefaultLocalPort: Number(value(formData, "clientDefaultLocalPort") || "1080"),
      enabledProtocols: ["vless_reality"],
      expiresAt: value(formData, "expiresAt") || null,
    });
  } catch (error) {
    return stateError(error);
  }
  revalidatePath("/users");
  return { ok: true, message: "Proxy account created." };
}

// Imperative server action (called directly from the client reveal button).
// Returns the full subscription URL for owner/admin; the API records an audit
// event. Kept off the table's default render so the token stays masked.
export async function revealSubscriptionAction(id: string): Promise<{ ok: boolean; url?: string; message?: string }> {
  try {
    const res = await apiMutation<{ account?: { subscriptionUrl?: string | null } }>(`/api/proxy-accounts/${encodeURIComponent(id)}/reveal`);
    const url = res.account?.subscriptionUrl ?? null;
    if (!url) return { ok: false, message: "Subscription URL is not available for your role." };
    return { ok: true, url };
  } catch (error) {
    return { ok: false, message: stateError(error).message };
  }
}

export async function proxyCommandAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = value(formData, "id");
  const command = value(formData, "command");
  try {
    if (command === "delete") {
      await apiMutation(`/api/proxy-accounts/${encodeURIComponent(id)}`, {}, "DELETE");
    } else {
      await apiMutation(`/api/proxy-accounts/${encodeURIComponent(id)}/${command}`);
    }
  } catch (error) {
    return stateError(error);
  }
  revalidatePath("/users");
  return { ok: true, message: command === "delete" ? "Proxy account deleted." : "Proxy account updated." };
}

export async function updateSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
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
  } catch (error) {
    return stateError(error);
  }
  revalidatePath("/settings");
  revalidatePath("/status");
  return { ok: true, message: "Settings saved." };
}

export async function runAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const command = value(formData, "command");
  const body = command === "render-caddyfile" ? { target: "caddyfile" } : command === "render-singbox" ? { target: "singbox" } : {};
  const path = command === "doctor" ? "/api/doctor/run" : command.startsWith("render-") ? "/api/render" : `/api/actions/${command}`;
  try {
    await apiMutation(path, body);
  } catch (error) {
    return stateError(error);
  }
  revalidatePath("/status");
  return { ok: true, message: `${command} complete.` };
}
