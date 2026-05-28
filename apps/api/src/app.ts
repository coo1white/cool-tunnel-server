// SPDX-License-Identifier: AGPL-3.0-only

import { createHmac } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AdminConfig } from "@cool-tunnel/config";
import {
  AdminStore,
  StoreError,
  type CreateProxyAccountInput,
  type CreateUserInput,
  type UpdateUserInput,
} from "@cool-tunnel/db";
import type {
  AdminUser,
  ApiErrorBody,
  ApiOk,
  Permission,
  ProtocolKey,
  ServerSettings,
} from "@cool-tunnel/shared";
import {
  AuditResponseSchema,
  DEFAULT_PROTOCOL_KEYS,
  MeResponseSchema,
  ProxyAccountResponseSchema,
  ProxyAccountsResponseSchema,
  SettingsResponseSchema,
  StatusResponseSchema,
  UserResponseSchema,
  UsersResponseSchema,
  hasPermission,
  roleAtLeast,
  z,
  type AdminRole,
} from "@cool-tunnel/shared";
import {
  constantTimeEqual,
  hashBootstrapToken,
  hashPassword,
  randomToken,
  redactSensitive,
  validatePassword,
  validBootstrapTokenShape,
  verifyPassword,
} from "@cool-tunnel/security";
import { createAuth, getCurrentSession, type AuthInstance, type CurrentSession } from "./auth";
import { isCoreAction, runCoreAction, type BoundaryResult, type CoreAction } from "./core-boundary";
import { containerServices } from "./docker";

type Vars = {
  store: AdminStore;
  auth: AuthInstance;
  session: CurrentSession;
};

export interface ApiAppOptions {
  readonly config: AdminConfig;
  readonly store: AdminStore;
  readonly auth?: AuthInstance;
}

export interface ApiApp {
  readonly app: Hono<{ Variables: Vars }>;
  readonly auth: AuthInstance;
  readonly store: AdminStore;
  readonly config: AdminConfig;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retrySafe = true,
    readonly next?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const LOGIN_CSRF_COOKIE = "ct_login_csrf";
const BOOTSTRAP_COOKIE = "ct_bootstrap_token";
const SUBSCRIPTION_TTL_SECONDS = 60 * 60 * 24 * 7;
const LOGIN_THROTTLE_WINDOW_MS = 60_000;
const LOGIN_THROTTLE_MAX = 5;
const LOGIN_THROTTLE_MAX_KEYS = 10_000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function pruneLoginAttempts(now: number): void {
  for (const [key, entry] of loginAttempts) {
    if (entry.resetAt <= now) loginAttempts.delete(key);
  }
  // Hard cap so a flood of distinct client IPs within one window (X-Forwarded-For
  // is attacker-controlled) cannot grow the Map without bound. Drop oldest first.
  while (loginAttempts.size > LOGIN_THROTTLE_MAX_KEYS) {
    const oldest = loginAttempts.keys().next().value;
    if (oldest === undefined) break;
    loginAttempts.delete(oldest);
  }
}

export function createApiApp(options: ApiAppOptions): ApiApp {
  const auth = options.auth ?? createAuth(options.config);
  const store = options.store;
  store.ensureDefaults(options.config);
  const app = new Hono<{ Variables: Vars }>();

  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("auth", auth);
    await next();
  });
  app.use("*", securityHeaders());
  app.use("*", csrfProtection(options.config));

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.get("/up", (c) => c.json({ ok: true, service: "ct-admin-api", version: options.config.version }));
  app.get("/", (c) => redirectNoStore(store.hasOwner() ? "/dashboard" : "/setup"));

  app.get("/login", (c) => {
    if (new URL(c.req.url).search) return redirectNoStore("/login");
    return loginResponse(c, "");
  });
  app.post("/login", async (c) => {
    const form = await c.req.formData();
    const csrf = String(form.get("csrf") ?? "");
    const csrfCookie = getCookie(c, LOGIN_CSRF_COOKIE) ?? "";
    if (!validLoginCsrf(csrf, csrfCookie)) {
      return loginResponse(c, "Sign in expired. Reload the sign-in page and try again.", 403);
    }
    const throttle = checkLoginThrottle(c, options.config);
    if (!throttle.ok) {
      return loginResponse(c, "Too many sign-in attempts. Wait a minute and try again.", 429);
    }
    const response = await auth.handler(new Request(`${options.config.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: trustedHeaderOrFallback(c.req.header("origin"), options.config.baseUrl),
        referer: trustedHeaderOrFallback(c.req.header("referer"), `${options.config.baseUrl}/login`),
        "x-forwarded-for": c.req.header("x-forwarded-for") ?? "",
        cookie: c.req.header("cookie") ?? "",
      },
      body: JSON.stringify({
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
        rememberMe: true,
      }),
    }));
    if (!response.ok) {
      recordFailedLogin(throttle.key);
      return loginResponse(c, "Sign in failed. Check the email and password.", 401);
    }
    clearLoginThrottle(throttle.key);
    const headers = new Headers({
      location: "/dashboard",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    appendSetCookies(headers, response);
    headers.append("set-cookie", cookieHeader(LOGIN_CSRF_COOKIE, "", { maxAge: 0, sameSite: "Strict", httpOnly: true }, options.config));
    const userId = (await response.clone().json().catch(() => null) as { user?: { id?: string } } | null)?.user?.id;
    if (userId) store.markLogin(userId, clientIp(c));
    return new Response(null, { status: 303, headers });
  });

  app.get("/setup", (c) => {
    if (store.hasOwner()) return setupPage(c, "Bootstrap is disabled because an owner already exists.", 403);
    if (new URL(c.req.url).search && !c.req.query("token")) return redirectNoStore("/setup");
    const token = c.req.query("token");
    if (token) return bootstrapTokenCookieRedirect(token, options.config);
    return setupPage(c, "");
  });
  app.post("/setup", async (c) => {
    if (store.hasOwner()) return setupPage(c, "Bootstrap is disabled because an owner already exists.", 403);
    const form = await c.req.formData();
    const token = String(form.get("token") ?? "").trim() || (getCookie(c, BOOTSTRAP_COOKIE) ?? "");
    try {
      if (!validBootstrapTokenShape(token)) throw new HttpError(403, "invalid_bootstrap_token", "Bootstrap token is invalid or expired.");
      const password = String(form.get("password") ?? "");
      if (!validatePassword(password)) throw new HttpError(400, "invalid_password", "Password must be at least 12 characters.");
      const passwordHash = await hashPassword(password);
      const tokenHash = await hashBootstrapToken(token, options.config.authSecret);
      store.createFirstOwner({
        email: String(form.get("email") ?? ""),
        username: String(form.get("username") ?? ""),
        name: String(form.get("name") ?? ""),
        role: "owner",
        passwordHash,
      }, tokenHash);
      const response = redirectNoStore("/login");
      response.headers.append("set-cookie", cookieHeader(BOOTSTRAP_COOKIE, "", { maxAge: 0, sameSite: "Strict", httpOnly: true }, options.config));
      return response;
    } catch (error) {
      return setupPage(c, errorMessage(error), statusFromError(error));
    }
  });

  app.get("/api/v1/subscription/:token", async (c) => subscriptionResponse(c, store));

  app.use("/api/*", requireSession(auth));
  app.use("/api/*", requireApiCsrf(options.config));

  // When an account is flagged to change its password (e.g. after an admin
  // reset), block the rest of the API until it is rotated. Only the session
  // probe, logout, and the self-service change endpoint stay reachable.
  app.use("/api/*", async (c, next) => {
    if (!c.get("session").user.mustChangePassword) return next();
    const path = c.req.path;
    if (path === "/api/me" || path === "/api/logout" || path === "/api/me/password") return next();
    throw new HttpError(403, "password_change_required", "Change your password before continuing.", false, "/change-password");
  });

  app.post("/api/me/password", async (c) => {
    const body = await safeJson(c);
    const currentPassword = String(body.currentPassword ?? "");
    const newPassword = String(body.newPassword ?? "");
    if (!validatePassword(newPassword)) throw new HttpError(400, "invalid_password", "Password must be at least 12 characters.");
    const userId = c.get("session").user.id;
    const hash = store.getOwnPasswordHash(userId);
    if (!hash || !(await verifyPassword(currentPassword, hash))) throw new HttpError(400, "invalid_current_password", "Current password is incorrect.");
    if (await verifyPassword(newPassword, hash)) throw new HttpError(400, "password_reused", "Choose a password you have not used before.");
    store.changeOwnPassword(userId, await hashPassword(newPassword), String(c.get("session").session.token ?? ""), clientIp(c));
    return ok(c);
  });

  app.get("/api/me", (c) => ok(c, {
    user: c.get("session").user,
    permissions: permissionsFor(c.get("session").user),
    csrfToken: csrfTokenForSession(c.get("session"), options.config),
  }, 200, MeResponseSchema));

  app.get("/api/users", requirePermission("users:read"), (c) => ok(c, { users: store.listUsers() }, 200, UsersResponseSchema));
  app.post("/api/users", requirePermission("users:create"), async (c) => {
    const actor = c.get("session").user;
    const body = await safeJson(c);
    const role = parseRole(body.role ?? "viewer");
    if (!roleAtLeast(actor.role, "admin")) throw new HttpError(403, "forbidden", "Your role cannot manage users.");
    if (role === "owner" && actor.role !== "owner") throw new HttpError(403, "owner_required", "Only owners can create owner accounts.");
    const password = String(body.password ?? "");
    if (!validatePassword(password)) throw new HttpError(400, "invalid_password", "Password must be at least 12 characters.");
    const input: CreateUserInput = {
      email: String(body.email ?? ""),
      username: String(body.username ?? ""),
      name: String(body.name ?? ""),
      passwordHash: await hashPassword(password),
      role,
      mustChangePassword: body.mustChangePassword !== false,
    };
    return ok(c, { user: store.createUser(actor as AdminUser, input) }, 201, UserResponseSchema);
  });
  app.get("/api/users/:id", requirePermission("users:read"), (c) => {
    const user = store.getUser(requiredParam(c, "id"));
    if (!user) throw new HttpError(404, "not_found", "User was not found.");
    return ok(c, { user }, 200, UserResponseSchema);
  });
  app.patch("/api/users/:id", requirePermission("users:update"), async (c) => {
    const body = await safeJson(c);
    const input: UpdateUserInput = {};
    if (body.email !== undefined) input.email = String(body.email);
    if (body.username !== undefined) input.username = String(body.username);
    if (body.name !== undefined) input.name = String(body.name);
    if (body.role !== undefined) input.role = parseRole(body.role);
    if (body.status !== undefined) input.status = body.status === "disabled" ? "disabled" : "active";
    if (body.mustChangePassword !== undefined) input.mustChangePassword = Boolean(body.mustChangePassword);
    return ok(c, { user: store.updateUser(c.get("session").user as AdminUser, requiredParam(c, "id"), input) }, 200, UserResponseSchema);
  });
  app.post("/api/users/:id/enable", requirePermission("users:disable"), (c) => ok(c, { user: store.enableUser(c.get("session").user as AdminUser, requiredParam(c, "id")) }, 200, UserResponseSchema));
  app.post("/api/users/:id/disable", requirePermission("users:disable"), (c) => ok(c, { user: store.disableUser(c.get("session").user as AdminUser, requiredParam(c, "id")) }, 200, UserResponseSchema));
  app.post("/api/users/:id/reset-password", requirePermission("users:reset-password"), async (c) => {
    const body = await safeJson(c);
    const password = String(body.password ?? "");
    if (!validatePassword(password)) throw new HttpError(400, "invalid_password", "Password must be at least 12 characters.");
    return ok(c, { user: store.resetPassword(c.get("session").user as AdminUser, requiredParam(c, "id"), await hashPassword(password)) }, 200, UserResponseSchema);
  });
  app.delete("/api/users/:id", requirePermission("users:delete"), (c) => {
    store.deleteUser(c.get("session").user as AdminUser, requiredParam(c, "id"));
    return ok(c);
  });

  app.get("/api/proxy-accounts", requirePermission("proxy-accounts:read"), (c) => ok(c, { accounts: store.listProxyAccounts() }, 200, ProxyAccountsResponseSchema));
  app.post("/api/proxy-accounts", requirePermission("proxy-accounts:write"), async (c) => {
    const input = parseProxyInput(await safeJson(c));
    return ok(c, { account: store.createProxyAccount(c.get("session").user as AdminUser, input) }, 201, ProxyAccountResponseSchema);
  });
  app.get("/api/proxy-accounts/:id", requirePermission("proxy-accounts:read"), (c) => {
    const account = store.getProxyAccount(requiredParam(c, "id"));
    if (!account) throw new HttpError(404, "not_found", "Proxy account was not found.");
    return ok(c, { account: redactProxyAccountFor(c.get("session").user.role, account as unknown as Record<string, unknown>) }, 200, ProxyAccountResponseSchema);
  });
  app.patch("/api/proxy-accounts/:id", requirePermission("proxy-accounts:write"), async (c) => ok(c, {
    account: store.updateProxyAccount(c.get("session").user as AdminUser, requiredParam(c, "id"), parseProxyInput(await safeJson(c), true)),
  }, 200, ProxyAccountResponseSchema));
  app.post("/api/proxy-accounts/:id/enable", requirePermission("proxy-accounts:write"), (c) => ok(c, { account: store.setProxyEnabled(c.get("session").user as AdminUser, requiredParam(c, "id"), true) }, 200, ProxyAccountResponseSchema));
  app.post("/api/proxy-accounts/:id/disable", requirePermission("proxy-accounts:write"), (c) => ok(c, { account: store.setProxyEnabled(c.get("session").user as AdminUser, requiredParam(c, "id"), false) }, 200, ProxyAccountResponseSchema));
  app.post("/api/proxy-accounts/:id/regenerate-uuid", requirePermission("proxy-accounts:write"), (c) => ok(c, { account: store.regenerateProxyUuid(c.get("session").user as AdminUser, requiredParam(c, "id")) }, 200, ProxyAccountResponseSchema));
  app.delete("/api/proxy-accounts/:id", requirePermission("proxy-accounts:write"), (c) => {
    store.deleteProxyAccount(c.get("session").user as AdminUser, requiredParam(c, "id"));
    return ok(c);
  });

  app.get("/api/settings", requirePermission("settings:read"), (c) => ok(c, { settings: store.getSettings() }, 200, SettingsResponseSchema));
  app.patch("/api/settings", requirePermission("settings:update"), async (c) => {
    const settings = await safeJson(c) as Partial<ServerSettings>;
    return ok(c, { settings: store.updateSettings(c.get("session").user as AdminUser, settings) }, 200, SettingsResponseSchema);
  });
  app.get("/api/status", requirePermission("status:read"), async (c) => {
    const summary = store.statusSummary();
    // Merge live runtime-container health (best-effort; never throws).
    summary.services = [...summary.services, ...(await containerServices())];
    return ok(c, { status: summary }, 200, StatusResponseSchema);
  });
  app.post("/api/doctor/run", requirePermission("ops:doctor"), async (c) => coreActionResponse(c, "doctor", store, options.config));
  app.post("/api/render", requirePermission("ops:render"), async (c) => {
    const body: Record<string, unknown> = await safeJson(c).catch(() => ({}));
    const target = String(body.target ?? "singbox");
    const action: CoreAction = target === "caddyfile" ? "render-caddyfile" : "render-singbox";
    return coreActionResponse(c, action, store, options.config);
  });
  app.post("/api/actions/:action", async (c) => {
    const action = actionForRoute(requiredParam(c, "action"));
    if (!action) throw new HttpError(404, "unknown_action", "Unknown operational action.");
    requirePermissionForAction(action)(c);
    return coreActionResponse(c, action, store, options.config);
  });
  app.post("/api/logout", async (c) => {
    const response = await auth.handler(new Request(`${options.config.baseUrl}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: c.req.header("cookie") ?? "",
      },
      body: "{}",
    }));
    const ip = clientIp(c);
    store.audit(c.get("session").user.id, "auth.logout", "user", c.get("session").user.id, ip ? { ip } : {});
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: response.headers,
    });
  });
  app.get("/api/audit", requirePermission("audit:read"), (c) => {
    const parsed = Number(c.req.query("limit"));
    return ok(c, { audit: store.listAudit(Number.isFinite(parsed) ? parsed : 100) }, 200, AuditResponseSchema);
  });

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) return apiError(c, new HttpError(404, "not_found", "Route was not found."));
    return coverSiteResponse(c);
  });
  app.onError((error, c) => {
    const http = normalizeError(error);
    process.stderr.write(redactSensitive(`[api] ${http.code}: ${error instanceof Error ? error.message : String(error)}\n`));
    if (c.req.path.startsWith("/api/")) return apiError(c, http);
    return new Response(redactSensitive(http.message), { status: http.status, headers: noStoreHeaders() });
  });

  return { app, auth, store, config: options.config };
}

function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (c.req.path === "/login") {
      c.header("Content-Security-Policy", "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'");
    }
    if (c.req.path === "/login" || c.req.path === "/setup" || c.req.path.startsWith("/api/auth/")) {
      c.header("Cache-Control", "no-store");
    }
  };
}

function csrfProtection(config: AdminConfig): MiddlewareHandler {
  return async (c, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    if (c.req.path.startsWith("/api/auth/") || c.req.path === "/login" || c.req.path === "/setup") return next();
    const origin = c.req.header("origin");
    if (origin && !config.trustedOrigins.includes(origin)) throw new HttpError(403, "csrf", "Request origin is not trusted.");
    const secFetchSite = c.req.header("sec-fetch-site")?.toLowerCase();
    if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") throw new HttpError(403, "csrf", "Cross-site admin requests are blocked.");
    return next();
  };
}

function requireApiCsrf(config: AdminConfig): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    const csrf = c.req.header("x-csrf-token") ?? "";
    if (!constantTimeEqual(csrf, csrfTokenForSession(c.get("session"), config))) throw new HttpError(403, "csrf", "CSRF token mismatch.");
    return next();
  };
}

function requireSession(auth: AuthInstance): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    const session = await getCurrentSession(auth, c.req.raw.headers);
    if (!session) throw new HttpError(401, "unauthorized", "Authentication required.");
    c.set("session", session);
    await next();
  };
}

function requirePermission(permission: Permission): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    const user = c.get("session").user as AdminUser;
    if (!hasPermission(user, permission)) throw new HttpError(403, "forbidden", "Permission denied.");
    await next();
  };
}

function requirePermissionForAction(action: CoreAction): (c: Context<{ Variables: Vars }>) => void {
  const permission = permissionForAction(action);
  return (c) => {
    const user = c.get("session").user as AdminUser;
    if (!hasPermission(user, permission)) throw new HttpError(403, "forbidden", "Permission denied.");
  };
}

async function coreActionResponse(c: Context<{ Variables: Vars }>, action: CoreAction, store: AdminStore, config: AdminConfig): Promise<Response> {
  if (!isCoreAction(action)) throw new HttpError(404, "unknown_action", "Unknown operational action.");
  const result = await runCoreAction(action, config, store);
  store.audit(c.get("session").user.id, `core.${action}`, "core", action, { code: result.code });
  return ok(c, { result: redactBoundary(result) }, result.ok ? 200 : 500);
}

async function subscriptionResponse(c: Context<{ Variables: Vars }>, store: AdminStore): Promise<Response> {
  const row = await store.resolveSubscriptionToken(requiredParam(c, "token"));
  if (!row) return coverSiteResponse(c);
  const account = rowToSubscriptionAccount(row);
  if (!account.enabled || (account.expiresAt && !(Date.parse(account.expiresAt) > Date.now()))) return coverSiteResponse(c);
  const settings = store.getSettings();
  if (!account.uuid || !settings.realityPublicKey || !settings.realityDestHost) return coverSiteResponse(c);
  const protocols = account.enabledProtocols.length > 0 ? account.enabledProtocols : DEFAULT_PROTOCOL_KEYS;
  if (!protocols.includes("vless_reality")) return coverSiteResponse(c);
  const issuedAt = Math.floor(Date.now() / 1000);
  const shortId = settings.realityShortIds[0] ?? "";
  const body: Record<string, unknown> = {
    version: 2,
    server: settings.domain,
    profiles: [{
      host: settings.domain,
      port: 443,
      username: account.username,
      uuid: account.uuid,
      label: `${settings.domain} (${account.username})`,
      client_defaults: { local_port: account.clientDefaultLocalPort },
      protocols: [{
        type: "vless_reality",
        host: settings.domain,
        port: 443,
        flow: "",
        security: "reality",
      }],
      reality: {
        public_key: settings.realityPublicKey,
        dest_host: settings.realityDestHost,
        short_id: shortId,
      },
    }],
    capabilities: {
      anti_tracking: [
        settings.antiTrackingHideIp ? "hide_ip" : null,
        settings.antiTrackingHideVia ? "hide_via" : null,
        settings.antiTrackingProbeResistance ? "probe_resistance" : null,
        settings.antiTrackingDohResolver ? "doh_resolver" : null,
      ].filter(Boolean),
      http3: false,
    },
    issued_at: issuedAt,
    expires_at: issuedAt + SUBSCRIPTION_TTL_SECONDS,
  };
  const canonical = JSON.stringify(body);
  const secret = store.config?.authSecret ?? "";
  body.signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return c.json(body, 200, { "cache-control": "no-store" });
}

function loginResponse(c: Context<{ Variables: Vars }>, message: string, status = 200): Response {
  const csrf = `ctcsrf_${randomToken(24)}`;
  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cool Tunnel Login</title>
<style>body{font-family:system-ui,sans-serif;margin:3rem auto;max-width:28rem;padding:0 1rem;background:#f7f7f4;color:#1b1b18}label{display:block;margin:.8rem 0 .25rem}input{box-sizing:border-box;width:100%;padding:.7rem;border:1px solid #bbb;background:white}button{margin-top:1rem;padding:.75rem 1rem;border:0;background:#0f766e;color:white;font-weight:700}.error{color:#9f1239}</style></head>
<body><h1>Cool Tunnel Admin</h1>${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
<form method="post" action="/login"><input type="hidden" name="csrf" value="${csrf}">
<label>Email</label><input name="email" type="email" autocomplete="username" required>
<label>Password</label><input name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form></body></html>`;
  const response = c.html(body, status as 200 | 401 | 403);
  response.headers.append("set-cookie", cookieHeader(LOGIN_CSRF_COOKIE, csrf, { sameSite: "Strict", httpOnly: true, maxAge: 600 }, c.get("store").config ?? undefined));
  return response;
}

function setupPage(c: Context<{ Variables: Vars }>, message: string, status = 200): Response {
  const tokenLoaded = Boolean(getCookie(c, BOOTSTRAP_COOKIE));
  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cool Tunnel Setup</title>
<style>body{font-family:system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem;background:#f7f7f4;color:#1b1b18}label{display:block;margin:.8rem 0 .25rem}input{box-sizing:border-box;width:100%;padding:.7rem;border:1px solid #bbb;background:white}button{margin-top:1rem;padding:.75rem 1rem;border:0;background:#0f766e;color:white;font-weight:700}.error{color:#9f1239}.note{color:#475569}</style></head>
<body><h1>Create First Owner</h1>${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
${tokenLoaded ? '<p class="note">A one-time bootstrap token is loaded for this browser.</p>' : '<p class="note">Run ct admin bootstrap and load the setup token first.</p>'}
<form method="post" action="/setup">
<label>Email</label><input name="email" type="email" required>
<label>Username</label><input name="username" required>
<label>Name</label><input name="name" required>
<label>Password</label><input name="password" type="password" autocomplete="new-password" required>
<button type="submit">Create owner</button></form></body></html>`;
  return c.html(body, status as 200 | 400 | 403);
}

function bootstrapTokenCookieRedirect(token: string, config: AdminConfig): Response {
  const headers = noStoreHeaders({ location: "/setup" });
  headers.append("set-cookie", cookieHeader(BOOTSTRAP_COOKIE, token, { sameSite: "Strict", httpOnly: true, maxAge: config.bootstrapTokenTtlMinutes * 60 }, config));
  return new Response(null, { status: 303, headers });
}

function redirectNoStore(location: string): Response {
  return new Response(null, { status: 303, headers: noStoreHeaders({ location }) });
}

function noStoreHeaders(init: Record<string, string> = {}): Headers {
  return new Headers({
    ...init,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
}

function cookieHeader(
  name: string,
  value: string,
  opts: { sameSite: "Lax" | "Strict"; httpOnly: boolean; maxAge: number },
  config?: Pick<AdminConfig, "secureCookies">,
): string {
  const encoded = `${name}=${encodeURIComponent(value)}`;
  return [
    encoded,
    "Path=/",
    `Max-Age=${opts.maxAge}`,
    opts.httpOnly ? "HttpOnly" : "",
    config?.secureCookies ? "Secure" : "",
    `SameSite=${opts.sameSite}`,
  ].filter(Boolean).join("; ");
}

function validLoginCsrf(value: string, cookieValue: string): boolean {
  return value.startsWith("ctcsrf_") && value.length > 24 && constantTimeEqual(value, cookieValue);
}

function trustedHeaderOrFallback(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.toLowerCase() !== "null" ? trimmed : fallback;
}

function appendSetCookies(headers: Headers, response: Response): void {
  const anyHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
  for (const cookie of anyHeaders.getSetCookie?.() ?? []) headers.append("set-cookie", cookie);
  if (!headers.has("set-cookie")) {
    const raw = response.headers.get("set-cookie");
    if (raw) headers.append("set-cookie", raw);
  }
}

function csrfTokenForSession(session: CurrentSession, config: Pick<AdminConfig, "authSecret">): string {
  const token = String(session.session.token ?? session.session.id ?? session.user.id);
  return createHmac("sha256", config.authSecret).update(`${session.user.id}:${token}`).digest("hex").slice(0, 32);
}

function loginThrottleKey(c: Context, config: AdminConfig): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const remote = forwarded || c.req.header("x-real-ip") || "unknown";
  return createHmac("sha256", config.authSecret).update(remote).digest("hex").slice(0, 24);
}

function clientIp(c: Context): string | null {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || c.req.header("x-real-ip") || null;
}

function checkLoginThrottle(c: Context, config: AdminConfig): { ok: true; key: string } | { ok: false; key: string } {
  const key = loginThrottleKey(c, config);
  const now = Date.now();
  pruneLoginAttempts(now);
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 0, resetAt: now + LOGIN_THROTTLE_WINDOW_MS });
    return { ok: true, key };
  }
  return current.count >= LOGIN_THROTTLE_MAX ? { ok: false, key } : { ok: true, key };
}

function recordFailedLogin(key: string): void {
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_THROTTLE_WINDOW_MS });
    return;
  }
  loginAttempts.set(key, { ...current, count: current.count + 1 });
}

function clearLoginThrottle(key: string): void {
  loginAttempts.delete(key);
}

function permissionsFor(user: CurrentSession["user"]): Permission[] {
  const permissions: Permission[] = [
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
  ];
  return permissions.filter((permission) => hasPermission(user as AdminUser, permission));
}

async function safeJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body");
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
  }
}

function parseRole(value: unknown): AdminRole {
  if (value === "owner" || value === "admin" || value === "operator" || value === "viewer") return value;
  throw new HttpError(400, "invalid_role", "Choose a valid role.");
}

function parseProxyInput(body: Record<string, unknown>, partial = false): CreateProxyAccountInput {
  const input = {} as CreateProxyAccountInput;
  if (!partial || body.username !== undefined) input.username = String(body.username ?? "");
  if (body.label !== undefined) input.label = body.label === null ? null : String(body.label);
  if (body.enabled !== undefined) input.enabled = Boolean(body.enabled);
  if (body.clientDefaultLocalPort !== undefined) input.clientDefaultLocalPort = Number(body.clientDefaultLocalPort);
  if (Array.isArray(body.enabledProtocols)) input.enabledProtocols = body.enabledProtocols.filter((item): item is ProtocolKey => item === "vless_reality");
  if (body.expiresAt !== undefined) input.expiresAt = body.expiresAt === null ? null : String(body.expiresAt);
  return input;
}

function requiredParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new HttpError(400, "bad_request", `Missing ${name}.`);
  return value;
}

function permissionForAction(action: CoreAction): Permission {
  switch (action) {
    case "doctor": return "ops:doctor";
    case "render-caddyfile":
    case "render-singbox": return "ops:render";
    case "restart-services": return "ops:restart";
    case "backup": return "ops:backup";
    case "restore": return "ops:restore";
  }
}

function actionForRoute(value: string): CoreAction | null {
  switch (value) {
    case "doctor": return "doctor";
    case "render":
    case "render-singbox": return "render-singbox";
    case "render-caddyfile": return "render-caddyfile";
    case "restart":
    case "restart-services": return "restart-services";
    case "backup": return "backup";
    case "restore": return "restore";
    default: return null;
  }
}

function ok<T extends object = Record<string, never>>(c: Context, payload = {} as T, status = 200, schema?: z.ZodTypeAny): Response {
  let data = payload;
  if (schema) {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
      throw new HttpError(500, "contract_violation", `Response payload did not match the API contract: ${detail}`, false);
    }
    data = parsed.data;
  }
  return c.json({ ok: true, ...data } satisfies ApiOk<T>, status as 200 | 201 | 500);
}

function apiError(c: Context, error: HttpError): Response {
  const body: ApiErrorBody = {
    ok: false,
    error: {
      code: error.code,
      message: redactSensitive(error.message),
      retrySafe: error.retrySafe,
      ...(error.next ? { next: redactSensitive(error.next) } : {}),
    },
  };
  return c.json(body, error.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
}

function normalizeError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof StoreError) return new HttpError(error.status, error.code, error.message);
  return new HttpError(500, "internal_error", "The admin API failed while handling this request. Check the admin service logs and retry after fixing the underlying component.", true, "docker compose logs --tail=120 admin-api");
}

function statusFromError(error: unknown): number {
  const status = normalizeError(error).status;
  return status === 400 || status === 403 ? status : 400;
}

function errorMessage(error: unknown): string {
  return normalizeError(error).message;
}

function redactBoundary(result: BoundaryResult): BoundaryResult {
  return {
    ok: result.ok,
    code: result.code,
    stdout: redactSensitive(result.stdout),
    stderr: redactSensitive(result.stderr),
  };
}

function redactProxyAccountFor(role: AdminRole, account: Record<string, unknown>): Record<string, unknown> {
  if (role === "owner" || role === "admin") return account;
  const copy = { ...account };
  delete copy.uuid;
  delete copy.subscriptionUrl;
  return copy;
}

function rowToSubscriptionAccount(row: Record<string, unknown>): {
  username: string;
  uuid: string;
  enabled: boolean;
  expiresAt: string | null;
  clientDefaultLocalPort: number;
  enabledProtocols: ProtocolKey[];
} {
  let enabledProtocols: ProtocolKey[] = [...DEFAULT_PROTOCOL_KEYS];
  try {
    const parsed = JSON.parse(String(row.enabledProtocols ?? "[]"));
    if (Array.isArray(parsed)) enabledProtocols = parsed.filter((item): item is ProtocolKey => item === "vless_reality");
  } catch {
    enabledProtocols = [...DEFAULT_PROTOCOL_KEYS];
  }
  return {
    username: String(row.username ?? ""),
    uuid: String(row.uuid ?? ""),
    enabled: Number(row.enabled ?? 0) === 1,
    expiresAt: row.expiresAt === null || row.expiresAt === undefined ? null : String(row.expiresAt),
    clientDefaultLocalPort: Number(row.clientDefaultLocalPort ?? 1080),
    enabledProtocols,
  };
}

function coverSiteResponse(c: Context): Response {
  const body = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Welcome</title></head><body><h1>Welcome</h1><p>Nothing to see here.</p></body></html>";
  const etag = createHmac("sha256", "cover").update(body).digest("hex").slice(0, 16);
  if (c.req.header("if-none-match") === `"${etag}"`) {
    return new Response(null, { status: 304, headers: { etag: `"${etag}"`, "cache-control": "public, max-age=3600" } });
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
      etag: `"${etag}"`,
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}
