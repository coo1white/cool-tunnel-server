// SPDX-License-Identifier: AGPL-3.0-only
// Bun/Hono admin panel. Server-rendered, no heavy frontend framework.

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { AdminConfig } from "./config";
import { loadAdminConfig, validateEmail, validateUserId } from "./config";
import { AdminStorage, ensureServerConfig, type AdminUserRow, type AuditRow } from "./storage";
import { createAuth, createAdminUserWithPassword, createFirstOwnerWithBootstrapToken, getCurrentSession, hashAdminPassword, type CurrentSession } from "./auth";
import { bootstrapFailureMessage, hashValidBootstrapToken, validateOwnerInput } from "./bootstrap";
import { canCreateRole, canDeleteRole, canManageUsers, canRunAction, requireRole, roleAtLeast, type AdminRole } from "./roles";
import { isCoreAction, runCoreAction } from "./core-boundary";
import { redactSensitive } from "../util/redact";

type AppVariables = {
    session: CurrentSession;
};

export interface AdminApp {
    readonly app: Hono<{ Variables: AppVariables }>;
    readonly storage: AdminStorage;
    readonly auth: ReturnType<typeof createAuth>;
    readonly config: AdminConfig;
}

interface ApiErrorBody {
    readonly ok: false;
    readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retrySafe: boolean;
        readonly next?: string;
    };
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

export function createAdminApp(config: AdminConfig = loadAdminConfig()): AdminApp {
    const storage = new AdminStorage(config.dbPath);
    storage.migrate();
    ensureServerConfig(storage, config);
    const auth = createAuth(config);
    const app = new Hono<{ Variables: AppVariables }>();

    app.use("*", securityHeaders());
    app.use("*", csrfProtection(config));

    app.post("/api/auth/sign-in/email", async (c) => {
        const body = await c.req.raw.clone().json().catch(() => null) as Record<string, unknown> | null;
        const email = typeof body?.["email"] === "string" ? body["email"] : "";
        const user = safeUserByEmail(storage, email);
        if (user?.status === "disabled") {
            return c.json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, 401);
        }
        return auth.handler(c.req.raw);
    });

    // Official Better Auth Hono shape: mount both GET and POST and
    // pass Hono's raw Request to auth.handler.
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

    app.get("/up", (c) => c.json({ ok: true, service: "ct-admin" }));
    app.get("/", (c) => c.redirect(storage.ownerExists() ? "/admin" : "/setup/bootstrap"));
    app.get("/login", (c) => new URL(c.req.url).search ? redirectNoStore("/login") : loginResponse(c, config));
    app.post("/login", async (c) => {
        const form = await c.req.formData();
        const csrf = String(form.get("csrf") ?? "");
        const csrfCookie = parseCookie(c.req.header("cookie") ?? "", "ct_login_csrf");
        if (!validLoginCsrf(csrf, csrfCookie)) {
            return loginResponse(c, config, "Sign in expired. Reload the sign-in page and try again.", 403);
        }
        const formEmail = String(form.get("email") ?? "");
        const user = safeUserByEmail(storage, formEmail);
        if (user?.status === "disabled") {
            return loginResponse(c, config, "Sign in failed. Check the email and password.", 401);
        }
        const response = await auth.handler(new Request(`${config.baseUrl}/api/auth/sign-in/email`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: config.baseUrl,
                "x-forwarded-for": c.req.header("x-forwarded-for") ?? "",
                cookie: c.req.header("cookie") ?? "",
            },
            body: JSON.stringify({
                email: formEmail,
                password: String(form.get("password") ?? ""),
                rememberMe: true,
            }),
        }));
        if (!response.ok) {
            return loginResponse(c, config, "Sign in failed. Check the email and password.", 401);
        }
        const headers = new Headers({ location: "/admin", "cache-control": "no-store" });
        for (const cookie of response.headers.getSetCookie?.() ?? []) headers.append("set-cookie", cookie);
        const joinedCookie = response.headers.get("set-cookie");
        if (!headers.has("set-cookie") && joinedCookie) headers.append("set-cookie", joinedCookie);
        headers.append("set-cookie", loginCsrfCookie("", config, 0));
        return new Response(null, { status: 303, headers });
    });
    app.get("/setup/bootstrap", (c) => {
        if (storage.ownerExists()) {
            return c.html(layout("Bootstrap Disabled", messagePage("Bootstrap Disabled", "An owner account already exists. Sign in to manage admin users.", "/login", "Sign in")), 403);
        }
        const queryToken = c.req.query("token");
        if (queryToken) {
            return bootstrapTokenCookieRedirect(queryToken, config);
        }
        const hasTokenCookie = parseCookie(c.req.header("cookie") ?? "", "ct_bootstrap_token") !== "";
        return c.html(layout("Create Owner", bootstrapPage(hasTokenCookie)));
    });
    app.post("/setup/bootstrap", async (c) => {
        if (storage.ownerExists()) {
            return browserError(c, 403, "Bootstrap Disabled", "An owner account already exists. Sign in to manage admin users.", "/login", "Sign in");
        }
        const form = await c.req.formData();
        const token = String(form.get("token") ?? "").trim() || parseCookie(c.req.header("cookie") ?? "", "ct_bootstrap_token");
        const owner = validateOwnerInput({
            email: String(form.get("email") ?? ""),
            name: String(form.get("name") ?? ""),
            password: String(form.get("password") ?? ""),
        });
        const hashed = await hashValidBootstrapToken(config, token);
        if (!hashed.ok) {
            return browserError(c, 400, "Owner Bootstrap Failed", bootstrapFailureMessage(hashed.reason), "/setup/bootstrap", "Try again");
        }
        const created = await createFirstOwnerWithBootstrapToken(auth, storage, {
            tokenHash: hashed.tokenHash,
            ...owner,
        });
        if (!created.ok) {
            return browserError(c, 400, "Owner Bootstrap Failed", bootstrapFailureMessage(created.reason), "/setup/bootstrap", "Try again");
        }
        storage.audit(created.user.id, "bootstrap.owner_created", "user", created.user.id, { email: created.user.email, role: "owner" });
        const response = c.html(layout("Owner Created", messagePage("Owner Created", "The first owner account is ready. Bootstrap is now disabled.", "/login", "Sign in")), 201);
        response.headers.append("set-cookie", bootstrapTokenCookie("", config, 0));
        return response;
    });

    app.use("/admin/*", requireSession(auth, storage));
    app.use("/api/admin/*", requireSession(auth, storage));

    app.get("/admin", (c) => {
        const session = c.get("session");
        return c.html(layout("Dashboard", dashboardPage(session, storage.ownerExists())));
    });
    app.get("/admin/users", requireMinimumRole("admin"), (c) => {
        return c.html(layout("Users", usersPage(c.get("session"), storage.listUsers(), c.req.query("status") ?? "")));
    });
    app.get("/admin/users/new", requireMinimumRole("admin"), (c) => {
        return c.html(layout("Create User", userFormPage(c.get("session"), null)));
    });
    app.post("/admin/users/new", requireMinimumRole("admin"), async (c) => {
        const actor = c.get("session").user;
        if (!canManageUsers(actor.role)) throw new HttpError(403, "forbidden", "Your role cannot manage users.", true);
        const form = await c.req.formData();
        const role = requireRole(String(form.get("role") ?? "viewer"));
        if (!canCreateRole(actor.role, role)) {
            throw new HttpError(403, "role_not_allowed", `Role ${actor.role} cannot create ${role} users.`, true);
        }
        const email = validateEmail(String(form.get("email") ?? ""));
        const name = String(form.get("name") ?? "").trim();
        const password = String(form.get("password") ?? "");
        const created = await createAdminUserWithPassword(auth, storage, { email, name, password, role });
        storage.audit(actor.id, "user.created", "user", created.id, { email, role });
        return redirectNoStore(`/admin/users/${encodeURIComponent(created.id)}?status=created`);
    });
    app.get("/admin/users/:id", requireMinimumRole("admin"), (c) => {
        const id = validateUserId(c.req.param("id"));
        const user = storage.getUserById(id);
        if (!user) throw new HttpError(404, "not_found", "Admin user was not found.", true);
        return c.html(layout("User Details", userFormPage(c.get("session"), user, c.req.query("status") ?? "")));
    });
    app.post("/admin/users/:id/update", requireMinimumRole("admin"), async (c) => {
        const actor = c.get("session").user;
        const id = validateUserId(c.req.param("id"));
        const target = storage.getUserById(id);
        if (!target) throw new HttpError(404, "not_found", "Admin user was not found.", true);
        if (target.role === "owner" && actor.role !== "owner") {
            throw new HttpError(403, "owner_required", "Only an owner can update another owner.", true);
        }
        const form = await c.req.formData();
        const nextRole = requireRole(String(form.get("role") ?? target.role));
        if (!canCreateRole(actor.role, nextRole)) {
            throw new HttpError(403, "role_not_allowed", `Role ${actor.role} cannot assign ${nextRole}.`, true);
        }
        if (target.role === "owner" && nextRole !== "owner" && storage.ownerCount() <= 1) {
            throw new HttpError(400, "last_owner_blocked", "Cannot remove the last owner account. Create another owner first.", true);
        }
        const updated = storage.updateUser(id, {
            email: validateEmail(String(form.get("email") ?? "")),
            name: String(form.get("name") ?? ""),
            role: nextRole,
        });
        storage.audit(actor.id, "user.updated", "user", id, {
            emailChanged: updated.email !== target.email,
            nameChanged: updated.name !== target.name,
            roleFrom: updated.role !== target.role ? target.role : undefined,
            roleTo: updated.role !== target.role ? updated.role : undefined,
        });
        return redirectNoStore(`/admin/users/${encodeURIComponent(id)}?status=updated`);
    });
    app.post("/admin/users/:id/disable", requireMinimumRole("admin"), (c) => {
        const actor = c.get("session").user;
        const id = validateUserId(c.req.param("id"));
        disableUser(storage, actor, id);
        return redirectNoStore(`/admin/users/${encodeURIComponent(id)}?status=disabled`);
    });
    app.post("/admin/users/:id/enable", requireMinimumRole("admin"), (c) => {
        const actor = c.get("session").user;
        const id = validateUserId(c.req.param("id"));
        enableUser(storage, actor, id);
        return redirectNoStore(`/admin/users/${encodeURIComponent(id)}?status=enabled`);
    });
    app.post("/admin/users/:id/reset-password", requireMinimumRole("admin"), async (c) => {
        const actor = c.get("session").user;
        const id = validateUserId(c.req.param("id"));
        const target = storage.getUserById(id);
        if (!target) throw new HttpError(404, "not_found", "Admin user was not found.", true);
        if (!canCreateRole(actor.role, target.role)) {
            throw new HttpError(403, "role_not_allowed", `Role ${actor.role} cannot reset ${target.role} passwords.`, true);
        }
        const form = await c.req.formData();
        const passwordHash = await hashAdminPassword(auth, String(form.get("password") ?? ""));
        storage.setUserPasswordHash(id, passwordHash);
        storage.audit(actor.id, "user.password_reset", "user", id, { email: target.email, role: target.role });
        return redirectNoStore(`/admin/users/${encodeURIComponent(id)}?status=password-reset`);
    });
    app.post("/admin/users/:id/delete", requireMinimumRole("admin"), (c) => {
        const actor = c.get("session").user;
        const id = validateUserId(c.req.param("id"));
        deleteUser(storage, actor, id);
        return redirectNoStore("/admin/users?status=deleted");
    });
    app.get("/admin/audit", requireMinimumRole("admin"), (c) => {
        return c.html(layout("Audit", auditPage(storage.recentAudit())));
    });

    app.get("/api/admin/session", (c) => {
        const session = c.get("session");
        return c.json({ ok: true, user: session.user });
    });
    app.get("/api/admin/me", (c) => {
        const session = c.get("session");
        return c.json({ ok: true, user: session.user });
    });
    app.get("/api/admin/users", requireMinimumRole("admin"), (c) => {
        return c.json({ ok: true, users: storage.listUsers() });
    });
    app.post("/api/admin/users", requireMinimumRole("admin"), async (c) => {
        const actor = c.get("session").user;
        if (!canManageUsers(actor.role)) throw new HttpError(403, "forbidden", "Your role cannot manage users.", true);
        const body = await safeJson(c);
        const role = requireRole(body["role"] ?? "viewer");
        if (!canCreateRole(actor.role, role)) {
            throw new HttpError(403, "role_not_allowed", `Role ${actor.role} cannot create ${role} users.`, true);
        }
        const email = validateEmail(String(body["email"] ?? ""));
        const name = String(body["name"] ?? "").trim();
        const password = String(body["password"] ?? "");
        const created = await createAdminUserWithPassword(auth, storage, { email, name, password, role });
        storage.audit(actor.id, "user.created", "user", created.id, { email, role });
        return c.json({ ok: true, user: storage.getUserById(created.id) }, 201);
    });
    app.get("/api/admin/users/:id", requireMinimumRole("admin"), (c) => {
        const id = validateUserId(c.req.param("id"));
        const user = storage.getUserById(id);
        if (!user) throw new HttpError(404, "not_found", "Admin user was not found.", true);
        return c.json({ ok: true, user });
    });
    app.patch("/api/admin/users/:id", requireMinimumRole("admin"), async (c) => {
        const actor = c.get("session").user;
        const id = validateUserId(c.req.param("id"));
        const target = storage.getUserById(id);
        if (!target) throw new HttpError(404, "not_found", "Admin user was not found.", true);
        if (!canManageUsers(actor.role)) throw new HttpError(403, "forbidden", "Your role cannot manage users.", true);
        if (target.role === "owner" && actor.role !== "owner") {
            throw new HttpError(403, "owner_required", "Only an owner can update another owner.", true);
        }
        const body = await safeJson(c);
        const nextRole = body["role"] === undefined ? undefined : requireRole(body["role"]);
        if (nextRole !== undefined) {
            if (!canCreateRole(actor.role, nextRole)) {
                throw new HttpError(403, "role_not_allowed", `Role ${actor.role} cannot assign ${nextRole}.`, true);
            }
            if (target.role === "owner" && nextRole !== "owner" && storage.ownerCount() <= 1) {
                throw new HttpError(400, "last_owner_blocked", "Cannot remove the last owner account. Create another owner first.", true);
            }
        }
        const name = body["name"] === undefined ? undefined : String(body["name"] ?? "");
        const email = body["email"] === undefined ? undefined : validateEmail(String(body["email"] ?? ""));
        const updated = storage.updateUser(id, { name, email, role: nextRole });
        storage.audit(actor.id, "user.updated", "user", id, {
            emailChanged: email !== undefined && email !== target.email,
            nameChanged: name !== undefined && name.trim() !== target.name,
            roleFrom: nextRole !== undefined && nextRole !== target.role ? target.role : undefined,
            roleTo: nextRole !== undefined && nextRole !== target.role ? nextRole : undefined,
        });
        return c.json({ ok: true, user: updated });
    });
    app.patch("/api/admin/users/:id/role", requireMinimumRole("admin"), async (c) => {
        const actor = c.get("session").user;
        const id = validateUserId(c.req.param("id"));
        const target = storage.getUserById(id);
        if (!target) throw new HttpError(404, "not_found", "Admin user was not found.", true);
        const body = await safeJson(c);
        const role = requireRole(body["role"]);
        if (!canCreateRole(actor.role, role)) {
            throw new HttpError(403, "role_not_allowed", `Role ${actor.role} cannot assign ${role}.`, true);
        }
        if (target.role === "owner" && actor.role !== "owner") {
            throw new HttpError(403, "owner_required", "Only an owner can change another owner.", true);
        }
        if (target.role === "owner" && role !== "owner" && storage.ownerCount() <= 1) {
            throw new HttpError(400, "last_owner_blocked", "Cannot remove the last owner account. Create another owner first.", true);
        }
        storage.setUserRole(id, role);
        storage.audit(actor.id, "user.role_changed", "user", id, { from: target.role, to: role });
        return c.json({ ok: true, user: storage.getUserById(id) });
    });
    app.post("/api/admin/users/:id/disable", requireMinimumRole("admin"), (c) => {
        const actor = c.get("session").user;
        const id = validateUserId(c.req.param("id"));
        disableUser(storage, actor, id);
        return c.json({ ok: true, user: storage.getUserById(id) });
    });
    app.post("/api/admin/users/:id/enable", requireMinimumRole("admin"), (c) => {
        const actor = c.get("session").user;
        const id = validateUserId(c.req.param("id"));
        enableUser(storage, actor, id);
        return c.json({ ok: true, user: storage.getUserById(id) });
    });
    app.post("/api/admin/users/:id/reset-password", requireMinimumRole("admin"), async (c) => {
        const actor = c.get("session").user;
        const id = validateUserId(c.req.param("id"));
        const target = storage.getUserById(id);
        if (!target) throw new HttpError(404, "not_found", "Admin user was not found.", true);
        if (!canCreateRole(actor.role, target.role)) {
            throw new HttpError(403, "role_not_allowed", `Role ${actor.role} cannot reset ${target.role} passwords.`, true);
        }
        const body = await safeJson(c);
        const password = String(body["password"] ?? "");
        const passwordHash = await hashAdminPassword(auth, password);
        storage.setUserPasswordHash(id, passwordHash);
        storage.audit(actor.id, "user.password_reset", "user", id, { email: target.email, role: target.role });
        return c.json({ ok: true });
    });
    app.delete("/api/admin/users/:id", requireMinimumRole("admin"), (c) => {
        const actor = c.get("session").user;
        const id = validateUserId(c.req.param("id"));
        if (id === actor.id) {
            throw new HttpError(400, "self_delete_blocked", "You cannot delete your own active admin account.", true);
        }
        const target = storage.getUserById(id);
        if (!target) throw new HttpError(404, "not_found", "Admin user was not found.", true);
        if (!canDeleteRole(actor.role, target.role)) {
            throw new HttpError(403, "role_not_allowed", `Role ${actor.role} cannot delete ${target.role} users.`, true);
        }
        deleteUser(storage, actor, id);
        return c.json({ ok: true });
    });
    app.get("/api/admin/audit", requireMinimumRole("admin"), (c) => {
        return c.json({ ok: true, audit: storage.recentAudit() });
    });
    app.post("/api/admin/doctor", requireAction("doctor"), async (c) => {
        const result = await runCoreAction("doctor", config);
        storage.audit(c.get("session").user.id, "core.doctor", "core", "doctor", { code: result.code });
        return c.json({ ok: result.ok, result: redactBoundary(result) }, result.ok ? 200 : 500);
    });
    app.post("/api/admin/actions/:action", async (c) => {
        const rawAction = c.req.param("action");
        const action = actionForRoute(rawAction);
        if (!action) throw new HttpError(404, "unknown_action", `Unknown admin action: ${rawAction}`, true);
        const session = c.get("session");
        if (!canRunAction(session.user.role, permissionForAction(action))) {
            throw new HttpError(403, "forbidden", `Role ${session.user.role} cannot run ${rawAction}.`, true);
        }
        const result = await runCoreAction(action, config);
        storage.audit(session.user.id, `core.${action}`, "core", action, { code: result.code });
        return c.json({ ok: result.ok, result: redactBoundary(result) }, result.ok ? 200 : 500);
    });

    app.notFound((c) => {
        if (c.req.path.startsWith("/api/")) {
            return apiError(c, new HttpError(404, "not_found", "Route was not found.", true));
        }
        return c.html(layout("Not Found", messagePage("Not Found", "That admin page does not exist.", "/admin", "Dashboard")), 404);
    });
    app.onError((err, c) => {
        const http = err instanceof HttpError
            ? err
            : new HttpError(500, "internal_error", "The admin server failed while handling this request. Check `docker compose logs --tail=120 panel`; retrying is safe after the underlying component is fixed.", true, "docker compose logs --tail=120 panel");
        process.stderr.write(redactSensitive(`[admin] ${http.code}: ${err instanceof Error ? err.message : String(err)}\n`));
        if (c.req.path.startsWith("/api/")) return apiError(c, http);
        return browserError(c, http.status, "Admin Error", http.message, "/admin", "Dashboard");
    });

    return { app, storage, auth, config };
}

export function startAdminServer(config: AdminConfig = loadAdminConfig()): void {
    const { app } = createAdminApp(config);
    Bun.serve({
        hostname: config.host,
        port: config.port,
        fetch: app.fetch,
    });
    process.stderr.write(`ct admin panel listening on ${config.host}:${config.port}\n`);
}

function securityHeaders(): MiddlewareHandler {
    return async (c, next) => {
        await next();
        c.header("X-Content-Type-Options", "nosniff");
        c.header("X-Frame-Options", "DENY");
        c.header("Referrer-Policy", "no-referrer");
        c.header("Cache-Control", "no-store");
        c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
        const scriptSrc = c.req.path === "/login" ? "script-src 'none'" : "script-src 'self' 'unsafe-inline'";
        c.header("Content-Security-Policy", `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'`);
    };
}

function csrfProtection(config: AdminConfig): MiddlewareHandler {
    return async (c, next) => {
        if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
            await next();
            return;
        }
        if (c.req.path.startsWith("/api/auth/") || c.req.path === "/login") {
            await next();
            return;
        }
        const secFetchSite = c.req.header("sec-fetch-site")?.toLowerCase();
        if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
            throw new HttpError(403, "csrf_blocked", "Cross-site admin requests are blocked. Reload the admin panel and retry.", true);
        }
        const origin = c.req.header("origin");
        const referer = c.req.header("referer");
        const allowed = new Set(config.trustedOrigins);
        if (origin) {
            if (!allowed.has(parseOrigin(origin))) {
                throw new HttpError(403, "csrf_blocked", "Request origin is not trusted for this admin panel.", true);
            }
        } else if (referer) {
            if (!allowed.has(parseOrigin(referer))) {
                throw new HttpError(403, "csrf_blocked", "Request referer is not trusted for this admin panel.", true);
            }
        } else if (config.appEnv === "production") {
            throw new HttpError(403, "csrf_blocked", "Admin mutation requests must include an Origin or Referer header.", true);
        }
        await next();
    };
}

function parseOrigin(value: string): string {
    try {
        return new URL(value).origin;
    } catch {
        throw new HttpError(403, "csrf_blocked", "Request origin is not a valid URL.", true);
    }
}

function requireSession(auth: ReturnType<typeof createAuth>, storage: AdminStorage): MiddlewareHandler<{ Variables: AppVariables }> {
    return async (c, next) => {
        const session = await getCurrentSession(auth, c.req.raw.headers);
        if (!session) {
            if (c.req.path.startsWith("/api/")) {
                return apiError(c, new HttpError(401, "unauthorized", "Authentication is required. Sign in and retry.", true, "Open /login"));
            }
            return c.redirect("/login");
        }
        const user = storage.getUserById(session.user.id);
        if (!user || user.status === "disabled") {
            if (user?.status === "disabled") storage.deleteSessionsForUser(user.id);
            if (c.req.path.startsWith("/api/")) {
                return apiError(c, new HttpError(401, "unauthorized", "Authentication is required. Sign in and retry.", true, "Open /login"));
            }
            return c.redirect("/login");
        }
        c.set("session", {
            session: session.session,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
            },
        });
        await next();
    };
}

function requireMinimumRole(role: AdminRole): MiddlewareHandler<{ Variables: AppVariables }> {
    return async (c, next) => {
        const session = c.get("session");
        if (!roleAtLeast(session.user.role, role)) {
            throw new HttpError(403, "forbidden", `Role ${session.user.role} does not have ${role} access.`, true);
        }
        await next();
    };
}

function requireAction(action: "doctor" | "restart" | "render" | "update" | "logs"): MiddlewareHandler<{ Variables: AppVariables }> {
    return async (c, next) => {
        const session = c.get("session");
        if (!canRunAction(session.user.role, action)) {
            throw new HttpError(403, "forbidden", `Role ${session.user.role} cannot run ${action}.`, true);
        }
        await next();
    };
}

async function safeJson(c: Context): Promise<Record<string, unknown>> {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "bad_json", "Expected a JSON object body.", true);
    }
    return body as Record<string, unknown>;
}

function apiError(c: Context, err: HttpError): Response {
    const body: ApiErrorBody = {
        ok: false,
        error: {
            code: err.code,
            message: err.message,
            retrySafe: err.retrySafe,
            next: err.next,
        },
    };
    return c.json(body, err.status as 400);
}

function safeUserByEmail(storage: AdminStorage, email: string) {
    try {
        return storage.getUserByEmail(email);
    } catch {
        return null;
    }
}

function disableUser(storage: AdminStorage, actor: CurrentSession["user"], id: string): AdminUserRow {
    if (id === actor.id) {
        throw new HttpError(400, "self_disable_blocked", "You cannot disable your own active admin account.", true);
    }
    const target = storage.getUserById(id);
    if (!target) throw new HttpError(404, "not_found", "Admin user was not found.", true);
    if (!canDeleteRole(actor.role, target.role)) {
        throw new HttpError(403, "role_not_allowed", `Role ${actor.role} cannot disable ${target.role} users.`, true);
    }
    if (target.role === "owner" && target.status === "active" && storage.ownerCount() <= 1) {
        throw new HttpError(400, "last_owner_blocked", "Cannot disable the last owner account. Create another owner first.", true);
    }
    storage.setUserStatus(id, "disabled");
    storage.audit(actor.id, "user.disabled", "user", id, { email: target.email, role: target.role });
    return storage.getUserById(id) ?? target;
}

function enableUser(storage: AdminStorage, actor: CurrentSession["user"], id: string): AdminUserRow {
    const target = storage.getUserById(id);
    if (!target) throw new HttpError(404, "not_found", "Admin user was not found.", true);
    if (!canCreateRole(actor.role, target.role)) {
        throw new HttpError(403, "role_not_allowed", `Role ${actor.role} cannot enable ${target.role} users.`, true);
    }
    storage.setUserStatus(id, "active");
    storage.audit(actor.id, "user.enabled", "user", id, { email: target.email, role: target.role });
    return storage.getUserById(id) ?? target;
}

function deleteUser(storage: AdminStorage, actor: CurrentSession["user"], id: string): void {
    if (id === actor.id) {
        throw new HttpError(400, "self_delete_blocked", "You cannot delete your own active admin account.", true);
    }
    const target = storage.getUserById(id);
    if (!target) throw new HttpError(404, "not_found", "Admin user was not found.", true);
    if (!canDeleteRole(actor.role, target.role)) {
        throw new HttpError(403, "role_not_allowed", `Role ${actor.role} cannot delete ${target.role} users.`, true);
    }
    if (target.role === "owner" && target.status === "active" && storage.ownerCount() <= 1) {
        throw new HttpError(400, "last_owner_blocked", "Cannot delete the last owner account. Create another owner first.", true);
    }
    storage.deleteUser(id);
    storage.audit(actor.id, "user.deleted", "user", id, { email: target.email, role: target.role });
}

function browserError(c: Context, status: number, title: string, message: string, href: string, label: string): Response {
    return c.html(layout(title, messagePage(title, message, href, label)), status as 400);
}

function loginResponse(c: Context, config: AdminConfig, error = "", status = 200): Response {
    const csrf = generateFormToken();
    const response = c.html(layout("Sign in", loginPage(csrf, error), { login: true }), status as 200);
    response.headers.append("set-cookie", loginCsrfCookie(csrf, config, 15 * 60));
    return response;
}

function redirectNoStore(location: string, status = 303): Response {
    return new Response(null, {
        status,
        headers: {
            location,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
        },
    });
}

function bootstrapTokenCookieRedirect(token: string, config: AdminConfig): Response {
    const headers = new Headers({
        location: "/setup/bootstrap",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
    });
    headers.append("set-cookie", bootstrapTokenCookie(token, config, config.bootstrapTokenTtlMinutes * 60));
    return new Response(null, { status: 303, headers });
}

function bootstrapTokenCookie(token: string, config: AdminConfig, maxAgeSeconds: number): string {
    const parts = [
        `ct_bootstrap_token=${encodeURIComponent(token)}`,
        "Path=/setup/bootstrap",
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ];
    if (config.secureCookies) parts.push("Secure");
    return parts.join("; ");
}

function loginCsrfCookie(token: string, config: AdminConfig, maxAgeSeconds: number): string {
    const parts = [
        `ct_login_csrf=${encodeURIComponent(token)}`,
        "Path=/login",
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ];
    if (config.secureCookies) parts.push("Secure");
    return parts.join("; ");
}

function generateFormToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return `ctcsrf_${Buffer.from(bytes).toString("base64url")}`;
}

function validLoginCsrf(formToken: string, cookieToken: string): boolean {
    return /^ctcsrf_[A-Za-z0-9_-]{32,128}$/.test(formToken) && formToken === cookieToken;
}

function parseCookie(header: string, key: string): string {
    for (const part of header.split(";")) {
        const [rawName, ...rawValue] = part.trim().split("=");
        if (rawName === key) {
            try {
                return decodeURIComponent(rawValue.join("="));
            } catch {
                return "";
            }
        }
    }
    return "";
}

function actionForRoute(route: string): "render-caddyfile" | "render-singbox" | "restart-services" | "update" | null {
    const map: Record<string, "render-caddyfile" | "render-singbox" | "restart-services" | "update"> = {
        "render-caddyfile": "render-caddyfile",
        "render-singbox": "render-singbox",
        restart: "restart-services",
        update: "update",
    };
    const action = map[route];
    return action && isCoreAction(action) ? action : null;
}

function permissionForAction(action: "render-caddyfile" | "render-singbox" | "restart-services" | "update"): "restart" | "render" | "update" {
    if (action === "restart-services") return "restart";
    if (action === "update") return "update";
    return "render";
}

function redactBoundary(result: { code: number; stdout: string; stderr: string }): { code: number; stdout: string; stderr: string } {
    return {
        code: result.code,
        stdout: redactSensitive(result.stdout).slice(0, 20_000),
        stderr: redactSensitive(result.stderr).slice(0, 20_000),
    };
}

function layout(title: string, body: string, opts: { readonly login?: boolean } = {}): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Cool Tunnel Admin</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f7f4;color:#1d2521}
body{margin:0;min-height:100vh}
main{max-width:980px;margin:0 auto;padding:32px 20px}
.shell{display:grid;gap:20px}
.panel{border:1px solid #ccd2cc;border-radius:8px;background:#fff;padding:20px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
h1{font-size:28px;line-height:1.15;margin:0 0 12px}
h2{font-size:18px;margin:0 0 10px}
p{line-height:1.5}
label{display:grid;gap:6px;margin:12px 0;font-weight:600}
input,select{font:inherit;padding:10px;border:1px solid #aeb7b0;border-radius:6px;background:#fff;color:#1d2521}
button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 14px;border:1px solid #1e5f54;border-radius:6px;background:#1e5f54;color:white;text-decoration:none;font-weight:700;cursor:pointer}
button.danger,.button.danger{border-color:#9f2424;background:#9f2424}.button.secondary,button.secondary{background:#fff;color:#1e5f54}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.topnav{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}.topnav a{color:#1e5f54;font-weight:700}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #dde3dd;vertical-align:top}.badge{display:inline-flex;border:1px solid #aeb7b0;border-radius:999px;padding:2px 8px;font-size:12px}
.muted{color:#5d6962}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{white-space:pre-wrap;overflow:auto;padding:12px;border-radius:6px;background:#10231f;color:#e8fff7}
@media (prefers-color-scheme:dark){:root{background:#111614;color:#e9efeb}.panel{background:#18201d;border-color:#35423b}input,select{background:#111614;color:#e9efeb;border-color:#526159}.button.secondary{background:#18201d;color:#e9efeb}}
</style>
</head>
<body>
<main>${body}</main>
${opts.login ? "" : clientScript()}
</body>
</html>`;
}

function clientScript(): string {
    return `<script>
async function signOut(){
  await fetch('/api/auth/sign-out',{method:'POST'});
  location.href='/login';
}
</script>`;
}

function nav(): string {
    return `<nav class="topnav"><a href="/admin">Dashboard</a><a href="/admin/users">Users</a><a href="/admin/audit">Audit</a><a href="/admin/users/new">New user</a><a href="#" onclick="signOut();return false">Sign out</a></nav>`;
}

function loginPage(csrf: string, error = ""): string {
    return `<div class="shell">
<section class="panel">
<h1>Cool Tunnel Admin</h1>
<p class="muted">Sign in with an owner, admin, operator, or viewer account.</p>
<form method="post" action="/login">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label>Email<input name="email" type="email" autocomplete="email" required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required minlength="12"></label>
<p data-error class="muted" role="alert">${escapeHtml(error)}</p>
<button type="submit">Sign in</button>
</form>
</section>
</div>`;
}

function bootstrapPage(hasTokenCookie: boolean): string {
    return `<div class="shell">
<section class="panel">
<h1>Create First Owner</h1>
<p class="muted">${hasTokenCookie ? "A one-time bootstrap token is loaded for this browser. It expires and is disabled after the first owner is created." : "Use the one-time token from the root-only setup file created by ct admin bootstrap. It expires and is disabled after the first owner is created."}</p>
<form method="post" action="/setup/bootstrap">
<label>Bootstrap token<input name="token" autocomplete="one-time-code" ${hasTokenCookie ? "" : "required"}></label>
<label>Name<input name="name" autocomplete="name" required maxlength="120"></label>
<label>Email<input name="email" type="email" autocomplete="email" required></label>
<label>Password<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label>
<button type="submit">Create owner</button>
</form>
</section>
</div>`;
}

function dashboardPage(session: CurrentSession, ownerExists: boolean): string {
    return `<div class="shell">
${nav()}
<section class="panel">
<h1>Dashboard</h1>
<p class="muted">Signed in as ${escapeHtml(session.user.email)} (${session.user.role}).</p>
<div class="grid">
<div><h2>Bootstrap</h2><p>${ownerExists ? "Disabled after owner creation." : "No owner exists. Run ct admin bootstrap."}</p></div>
<div><h2>Accounts</h2><p>Review roles, disable stale users, and reset credentials.</p><a class="button secondary" href="/admin/users">Manage users</a></div>
<div><h2>Doctor</h2><p>Run diagnostics from the API or CLI.</p><button onclick="fetch('/api/admin/doctor',{method:'POST'}).then(r=>r.json()).then(j=>alert(JSON.stringify(j,null,2)))">Run doctor</button></div>
<div><h2>Session</h2><p>Secure httpOnly Better Auth cookie session.</p><button class="secondary" onclick="signOut()">Sign out</button></div>
</div>
</section>
</div>`;
}

function usersPage(session: CurrentSession, users: readonly AdminUserRow[], status: string): string {
    const rows = users.map((user) => `<tr>
<td><a href="/admin/users/${escapeHtml(user.id)}">${escapeHtml(user.email)}</a><br><span class="muted">${escapeHtml(user.name)}</span></td>
<td><span class="badge">${user.role}</span></td>
<td><span class="badge">${user.status}</span>${user.disabledAt ? `<br><span class="muted">${escapeHtml(user.disabledAt)}</span>` : ""}</td>
<td><span class="muted">${escapeHtml(user.updatedAt)}</span></td>
</tr>`).join("");
    return `<div class="shell">
${nav()}
<section class="panel">
<div class="row"><h1>Users</h1><a class="button" href="/admin/users/new">Create user</a></div>
<p class="muted">Signed in as ${escapeHtml(session.user.email)} (${session.user.role}).</p>
${statusMessage(status)}
${users.length === 0 ? "<p>No admin accounts exist yet.</p>" : `<table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>`}
</section>
</div>`;
}

function userFormPage(session: CurrentSession, user: AdminUserRow | null, status = ""): string {
    const isNew = user === null;
    const action = isNew ? "/admin/users/new" : `/admin/users/${escapeHtml(user.id)}/update`;
    const title = isNew ? "Create User" : "User Details";
    const roleOptions = ["viewer", "operator", "admin", "owner"].filter((role) => canCreateRole(session.user.role, role as AdminRole) || role === user?.role).map((role) => {
        const selected = user?.role === role || (isNew && role === "viewer") ? " selected" : "";
        return `<option value="${role}"${selected}>${role}</option>`;
    }).join("");
    return `<div class="shell">
${nav()}
<section class="panel">
<h1>${title}</h1>
${statusMessage(status)}
<form method="post" action="${action}">
<label>Name<input name="name" value="${escapeHtml(user?.name ?? "")}" autocomplete="name" required maxlength="120"></label>
<label>Email<input name="email" type="email" value="${escapeHtml(user?.email ?? "")}" autocomplete="email" required></label>
<label>Role<select name="role">${roleOptions}</select></label>
${isNew ? '<label>Temporary password<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label>' : ""}
<div class="row"><button type="submit">${isNew ? "Create user" : "Save changes"}</button><a class="button secondary" href="/admin/users">Back</a></div>
</form>
</section>
${user ? userActionsPage(session, user) : ""}
</div>`;
}

function userActionsPage(session: CurrentSession, user: AdminUserRow): string {
    const canDeleteOrDisable = canDeleteRole(session.user.role, user.role) && user.id !== session.user.id;
    const canReset = canCreateRole(session.user.role, user.role);
    return `<section class="panel">
<h2>Account Actions</h2>
<p>Status: <span class="badge">${user.status}</span>${user.disabledAt ? ` <span class="muted">disabled ${escapeHtml(user.disabledAt)}</span>` : ""}</p>
<div class="row">
${canDeleteOrDisable && user.status === "active" ? `<form method="post" action="/admin/users/${escapeHtml(user.id)}/disable"><button class="secondary" type="submit">Disable</button></form>` : ""}
${canDeleteOrDisable && user.status === "disabled" ? `<form method="post" action="/admin/users/${escapeHtml(user.id)}/enable"><button class="secondary" type="submit">Enable</button></form>` : ""}
${canDeleteOrDisable ? `<form method="post" action="/admin/users/${escapeHtml(user.id)}/delete"><button class="danger" type="submit">Delete</button></form>` : ""}
</div>
${canReset ? `<form method="post" action="/admin/users/${escapeHtml(user.id)}/reset-password"><label>New temporary password<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label><button type="submit">Reset password</button></form>` : "<p class=\"muted\">Your role cannot reset this user's password.</p>"}
</section>`;
}

function auditPage(audit: readonly AuditRow[]): string {
    const rows = audit.map((row) => `<tr>
<td>${escapeHtml(row.createdAt)}</td>
<td>${escapeHtml(row.action)}</td>
<td>${escapeHtml(row.targetType ?? "")}</td>
<td class="mono">${escapeHtml(row.targetId ?? "")}</td>
<td><pre>${escapeHtml(row.detail ?? "")}</pre></td>
</tr>`).join("");
    return `<div class="shell">
${nav()}
<section class="panel">
<h1>Audit</h1>
${audit.length === 0 ? "<p>No audit entries yet.</p>" : `<table><thead><tr><th>Time</th><th>Action</th><th>Target</th><th>ID</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>`}
</section>
</div>`;
}

function statusMessage(status: string): string {
    const map: Record<string, string> = {
        created: "User created.",
        updated: "User updated.",
        disabled: "User disabled and active sessions revoked.",
        enabled: "User enabled.",
        "password-reset": "Password reset and active sessions revoked.",
        deleted: "User deleted.",
    };
    const message = map[status];
    return message ? `<p role="status">${escapeHtml(message)}</p>` : "";
}

function messagePage(title: string, message: string, href: string, label: string): string {
    return `<section class="panel"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="button" href="${escapeHtml(href)}">${escapeHtml(label)}</a></section>`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

if (import.meta.main) {
    startAdminServer();
}
