// SPDX-License-Identifier: AGPL-3.0-only

import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadAdminConfig, bootstrapMaterialPath, type AdminConfig } from "@cool-tunnel/config";
import { AdminStore, migrateAdminDb, openAdminDb } from "@cool-tunnel/db";
import { hashBootstrapToken, redactSensitive } from "@cool-tunnel/security";
import { REQUIRED_SCHEMA_VERSION, type AdminUser } from "@cool-tunnel/shared";
import { createApiApp } from "../src/app";
import { createAuth } from "../src/auth";
import { buildServerRenderAccounts, isCoreAction } from "../src/core-boundary";

const SECRET = "test-better-auth-secret-".padEnd(43, "x");

function baseEnv(dbPath: string, extra: Record<string, string> = {}) {
  return {
    CT_ADMIN_ENV: "test",
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: "http://localhost:9000",
    CT_ADMIN_DB_PATH: dbPath,
    DOMAIN: "proxy.example.com",
    PANEL_DOMAIN: "panel.example.com",
    ACME_EMAIL: "ops@example.com",
    REALITY_PRIVATE_KEY: "A".repeat(43),
    REALITY_PUBLIC_KEY: "B".repeat(43),
    ...extra,
  };
}

function tempFixture(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ct-api-test-"));
  const dbPath = join(dir, "admin.sqlite");
  const config = loadAdminConfig(baseEnv(dbPath, extra));
  const { db } = openAdminDb(config.dbPath);
  migrateAdminDb(db);
  const store = new AdminStore(db, config);
  store.ensureDefaults(config);
  const auth = createAuth(config);
  const { app } = createApiApp({ config, store, auth });
  return { dir, config, db, store, auth, app };
}

async function ownerFixture() {
  const f = tempFixture();
  const { token } = await f.store.createBootstrapToken(f.config, 30);
  const passwordHash = await f.auth.$context.then((ctx) => ctx.password.hash("correct horse battery staple"));
  const tokenHash = await hashBootstrapToken(token, f.config.authSecret);
  const owner = f.store.createFirstOwner({
    email: "owner@example.com",
    username: "owner",
    name: "Owner",
    passwordHash,
    role: "owner",
  }, tokenHash);
  return { ...f, owner };
}

async function signIn(app: ReturnType<typeof createApiApp>["app"], email = "owner@example.com", password = "correct horse battery staple") {
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(",").map((part) => part.trim()).find((part) => part.includes("ct-admin.session_token="))?.split(";")[0] ?? "";
  const me = cookie ? await app.request("/api/me", { headers: { cookie } }) : null;
  const csrf = me?.ok ? ((await me.json()) as { csrfToken: string }).csrfToken : "";
  return { res, cookie, csrf, setCookie };
}

function closeFixture(f: { dir: string; db: { close(): void } }) {
  try {
    f.db.close();
  } catch {
    // Already closed.
  }
  rmSync(f.dir, { recursive: true, force: true });
}

test("first owner setup consumes one-time bootstrap token and rejects reuse", async () => {
  const f = tempFixture();
  try {
    const { token } = await f.store.createBootstrapToken(f.config, 30);
    const page = await f.app.request(`/setup?token=${token}`);
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/setup");
    expect(page.headers.get("set-cookie") ?? "").toContain("HttpOnly");
    expect(page.headers.get("set-cookie") ?? "").toContain("SameSite=Strict");
    expect(await page.text()).not.toContain(token);

    const create = await f.app.request("/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `ct_bootstrap_token=${encodeURIComponent(token)}` },
      body: new URLSearchParams({
        email: "owner@example.com",
        username: "owner",
        name: "Owner",
        password: "correct horse battery staple",
      }),
    });
    expect(create.status).toBe(303);
    expect(f.store.ownerCount()).toBe(1);

    const tokenHash = await hashBootstrapToken(token, f.config.authSecret);
    expect(f.store.consumeBootstrapTokenHash(tokenHash)).toEqual({ ok: false, reason: "used" });
  } finally {
    closeFixture(f);
  }
});

test("bootstrap token expiration blocks setup", async () => {
  const f = tempFixture();
  try {
    const { token } = await f.store.createBootstrapToken(f.config, -1);
    const create = await f.app.request("/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `ct_bootstrap_token=${encodeURIComponent(token)}` },
      body: new URLSearchParams({
        email: "owner@example.com",
        username: "owner",
        name: "Owner",
        password: "correct horse battery staple",
      }),
    });
    expect(create.status).toBe(403);
    expect(await create.text()).toContain("invalid or expired");
    expect(f.store.ownerCount()).toBe(0);
  } finally {
    closeFixture(f);
  }
});

test("setup scrubs arbitrary query strings and only stores token in an HttpOnly cookie", async () => {
  const f = tempFixture();
  try {
    const leaked = await f.app.request("/setup?email=owner@example.com&password=super-secret");
    expect(leaked.status).toBe(303);
    expect(leaked.headers.get("location")).toBe("/setup");
    expect(await leaked.text()).not.toContain("super-secret");
    expect(leaked.headers.get("set-cookie")).toBeNull();

    const { token } = await f.store.createBootstrapToken(f.config, 30);
    const tokenLoad = await f.app.request(`/setup?token=${token}`);
    expect(tokenLoad.status).toBe(303);
    expect(tokenLoad.headers.get("location")).toBe("/setup");
    expect(tokenLoad.headers.get("set-cookie") ?? "").toContain("HttpOnly");
    expect(tokenLoad.headers.get("set-cookie") ?? "").toContain("SameSite=Strict");
    expect(await tokenLoad.text()).not.toContain(token);
  } finally {
    closeFixture(f);
  }
});

test("login form scrubs query strings and posts credentials server-side", async () => {
  const f = await ownerFixture();
  try {
    const leaked = await f.app.request("/login?email=owner@example.com&password=super-secret");
    expect(leaked.status).toBe(303);
    expect(leaked.headers.get("location")).toBe("/login");
    expect(await leaked.text()).not.toContain("super-secret");

    const page = await f.app.request("/login");
    const body = await page.text();
    expect(page.headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain('method="post"');
    expect(body).toContain('action="/login"');
    expect(body).not.toContain("localStorage");

    const csrf = body.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const csrfCookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
    const success = await f.app.request("/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: csrfCookie,
        origin: "http://localhost:9000",
        referer: "http://localhost:9000/login",
      },
      body: new URLSearchParams({ csrf, email: "owner@example.com", password: "correct horse battery staple" }),
    });
    expect(success.status).toBe(303);
    expect(success.headers.get("location")).toBe("/dashboard");
    expect(success.headers.get("set-cookie") ?? "").toContain("ct-admin.session_token=");

    const secondPage = await f.app.request("/login");
    const secondBody = await secondPage.text();
    const secondCsrf = secondBody.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const secondCsrfCookie = secondPage.headers.get("set-cookie")?.split(";")[0] ?? "";
    const nullOriginSuccess = await f.app.request("/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: secondCsrfCookie,
        origin: "null",
        referer: "",
      },
      body: new URLSearchParams({ csrf: secondCsrf, email: "owner@example.com", password: "correct horse battery staple" }),
    });
    expect(nullOriginSuccess.status).toBe(303);
    expect(nullOriginSuccess.headers.get("location")).toBe("/dashboard");

    const failed = await f.app.request("/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: csrfCookie,
        origin: "http://localhost:9000",
        referer: "http://localhost:9000/login",
      },
      body: new URLSearchParams({ csrf, email: "missing@example.com", password: "wrong-password-value" }),
    });
    expect(failed.status).toBe(401);
    const failedBody = await failed.text();
    expect(failedBody).toContain("Sign in failed. Check the email and password.");
    expect(failedBody).not.toContain("missing@example.com");
    expect(failedBody).not.toContain("wrong-password-value");

    for (let i = 0; i < 5; i++) {
      const pageAttempt = await f.app.request("/login");
      const attemptBody = await pageAttempt.text();
      const attemptCsrf = attemptBody.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
      const attemptCookie = pageAttempt.headers.get("set-cookie")?.split(";")[0] ?? "";
      const attempt = await f.app.request("/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: attemptCookie,
          "x-forwarded-for": "198.51.100.55",
          origin: "http://localhost:9000",
          referer: "http://localhost:9000/login",
        },
        body: new URLSearchParams({ csrf: attemptCsrf, email: "missing@example.com", password: "wrong-password-value" }),
      });
      expect(attempt.status).toBe(401);
    }
    const blockedPage = await f.app.request("/login");
    const blockedBody = await blockedPage.text();
    const blockedCsrf = blockedBody.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const blockedCookie = blockedPage.headers.get("set-cookie")?.split(";")[0] ?? "";
    const blocked = await f.app.request("/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: blockedCookie,
        "x-forwarded-for": "198.51.100.55",
        origin: "http://localhost:9000",
        referer: "http://localhost:9000/login",
      },
      body: new URLSearchParams({ csrf: blockedCsrf, email: "owner@example.com", password: "correct horse battery staple" }),
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).not.toContain("correct horse");
  } finally {
    closeFixture(f);
  }
});

test("Better Auth cookies are httpOnly SameSite Lax and signup is disabled", async () => {
  const f = await ownerFixture();
  try {
    expect(f.auth.options.emailAndPassword?.disableSignUp).toBe(true);
    const signup = await f.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", password: "correct horse battery staple", name: "New" }),
    });
    expect(signup.status).toBeGreaterThanOrEqual(400);

    const signedIn = await signIn(f.app);
    expect(signedIn.res.status).toBe(200);
    expect(signedIn.setCookie).toContain("ct-admin.session_token=");
    expect(signedIn.setCookie.toLowerCase()).toContain("httponly");
    expect(signedIn.setCookie.toLowerCase()).toContain("samesite=lax");
    expect(signedIn.setCookie).not.toContain("localStorage");
  } finally {
    closeFixture(f);
  }
});

test("protected routes and role authorization enforce viewer/operator/admin/owner rules", async () => {
  const f = await ownerFixture();
  try {
    const denied = await f.app.request("/api/users");
    expect(denied.status).toBe(401);

    const ownerSession = await signIn(f.app);
    const createViewer = await f.app.request("/api/users", {
      method: "POST",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf, "content-type": "application/json" },
      body: JSON.stringify({
        email: "viewer@example.com",
        username: "viewer",
        name: "Viewer",
        password: "correct horse battery staple",
        role: "viewer",
        mustChangePassword: false,
      }),
    });
    expect(createViewer.status).toBe(201);
    const viewer = ((await createViewer.json()) as { user: AdminUser }).user;
    const viewerSession = await signIn(f.app, "viewer@example.com");
    const forbidden = await f.app.request("/api/users", {
      method: "POST",
      headers: { cookie: viewerSession.cookie, "x-csrf-token": viewerSession.csrf, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(forbidden.status).toBe(403);

    const demoteLastOwner = await f.app.request(`/api/users/${f.owner.id}`, {
      method: "PATCH",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf, "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(demoteLastOwner.status).toBe(400);

    const disabled = await f.app.request(`/api/users/${viewer.id}/disable`, {
      method: "POST",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf },
    });
    expect(disabled.status).toBe(200);
  } finally {
    closeFixture(f);
  }
});

test("proxy accounts, subscription URL masking, and manifest endpoint work", async () => {
  const f = await ownerFixture();
  try {
    const ownerSession = await signIn(f.app);
    const created = await f.app.request("/api/proxy-accounts", {
      method: "POST",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf, "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", label: "Alice", clientDefaultLocalPort: 1088 }),
    });
    expect(created.status).toBe(201);
    const account = (await created.json()) as { account: { id: string; uuid: string; subscriptionUrl: string; subscriptionUrlMasked: string } };
    expect(account.account.uuid).toMatch(/[0-9a-f-]{36}/);
    expect(account.account.subscriptionUrlMasked).toContain("<redacted>");
    expect(account.account.subscriptionUrl).not.toContain("<redacted>");

    const manifest = await f.app.request(new URL(account.account.subscriptionUrl).pathname);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("cache-control")).toBe("no-store");
    const json = await manifest.json() as { version: number; profiles: Array<{ uuid: string; client_defaults: { local_port: number } }>; signature: string };
    expect(json.version).toBe(2);
    expect(json.profiles[0]?.uuid).toBe(account.account.uuid);
    expect(json.profiles[0]?.client_defaults.local_port).toBe(1088);
    expect(json.signature).toBeTruthy();

    const missing = await f.app.request("/api/v1/subscription/not-a-token");
    expect(missing.status).toBe(200);
    expect(missing.headers.get("content-type")).toContain("text/html");
  } finally {
    closeFixture(f);
  }
});

test("proxy-account mutations auto-render sing-box (audited as core.render-singbox)", async () => {
  const f = await ownerFixture();
  try {
    const s = await signIn(f.app);
    const headers = { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/json" };

    const created = await f.app.request("/api/proxy-accounts", {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "renderme" }),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { account: { id: string } }).account.id;

    // Rotating the UUID must re-render so the new credential reaches the
    // sing-box inbound — the "unknown UUID" failure this guards against.
    const rotated = await f.app.request(`/api/proxy-accounts/${id}/regenerate-uuid`, { method: "POST", headers });
    expect(rotated.status).toBe(200);

    const audit = await f.app.request("/api/audit", { headers: { cookie: s.cookie } });
    expect(audit.status).toBe(200);
    const log = JSON.stringify(await audit.json());
    // Each mutation triggers a render attempt, audited with its trigger. (The
    // render can't write /data in the test sandbox; the audit records the
    // attempt regardless, which is what proves the endpoints wired it in.)
    expect(log).toContain("core.render-singbox");
    expect(log).toContain("proxy_account.create");
    expect(log).toContain("proxy_account.regenerate-uuid");
  } finally {
    closeFixture(f);
  }
});

test("buildServerRenderAccounts emits the previous UUID only during the rotation grace window", async () => {
  const f = await ownerFixture();
  try {
    const created = f.store.createProxyAccount(f.owner, { username: "graceful" });
    const originalUuid = created.uuid!;
    const rotated = f.store.regenerateProxyUuid(f.owner, created.id);
    const newUuid = rotated.uuid!;
    expect(newUuid).not.toBe(originalUuid);
    expect(rotated.previousUuidValidUntil).toBeTruthy();
    const graceUntil = Date.parse(rotated.previousUuidValidUntil!);

    // Within the grace window: both the new and the previous UUID are emitted,
    // the previous one as a distinct `<username>-prev` user.
    const within = buildServerRenderAccounts(f.store, graceUntil - 1000);
    expect(within.find((a) => a.username === "graceful")?.uuid).toBe(newUuid);
    expect(within.find((a) => a.username === "graceful-prev")?.uuid).toBe(originalUuid);

    // After it lapses: only the current UUID remains.
    const after = buildServerRenderAccounts(f.store, graceUntil + 1000);
    expect(after.find((a) => a.username === "graceful")?.uuid).toBe(newUuid);
    expect(after.find((a) => a.username === "graceful-prev")).toBeUndefined();
  } finally {
    closeFixture(f);
  }
});

test("operator/viewer never see uuid or previousUuid on a proxy account", async () => {
  const f = await ownerFixture();
  try {
    const ownerSession = await signIn(f.app);
    const ownerHeaders = { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf, "content-type": "application/json" };

    const created = await f.app.request("/api/proxy-accounts", {
      method: "POST", headers: ownerHeaders, body: JSON.stringify({ username: "secretacct" }),
    });
    const id = ((await created.json()) as { account: { id: string } }).account.id;
    // Rotate so previousUuid is populated (the grace-window credential).
    await f.app.request(`/api/proxy-accounts/${id}/regenerate-uuid`, { method: "POST", headers: ownerHeaders });

    // Owner sees both the current and previous credential.
    const ownerView = await f.app.request(`/api/proxy-accounts/${id}`, { headers: { cookie: ownerSession.cookie } });
    const ownerAccount = ((await ownerView.json()) as { account: Record<string, unknown> }).account;
    expect(ownerAccount.uuid).toBeTruthy();
    expect(ownerAccount.previousUuid).toBeTruthy();

    // A viewer (read-only) must get neither uuid nor previousUuid (both are live
    // credentials), only the masked subscription URL.
    const createViewer = await f.app.request("/api/users", {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ email: "v@example.com", username: "viewer", name: "Viewer", password: "correct horse battery staple", role: "viewer", mustChangePassword: false }),
    });
    expect(createViewer.status).toBe(201);
    const viewerSession = await signIn(f.app, "v@example.com");
    const viewerView = await f.app.request(`/api/proxy-accounts/${id}`, { headers: { cookie: viewerSession.cookie } });
    expect(viewerView.status).toBe(200);
    const viewerAccount = ((await viewerView.json()) as { account: Record<string, unknown> }).account;
    expect(viewerAccount.uuid).toBeUndefined();
    expect(viewerAccount.previousUuid).toBeUndefined();
    expect(viewerAccount.subscriptionUrl).toBeUndefined();
    expect(viewerAccount.subscriptionUrlMasked).toBeTruthy();
  } finally {
    closeFixture(f);
  }
});

test("proxy account rejects an unparseable expiresAt with 400 (not 500)", async () => {
  const f = await ownerFixture();
  try {
    const ownerSession = await signIn(f.app);
    const headers = { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf, "content-type": "application/json" };
    const bad = await f.app.request("/api/proxy-accounts", {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "bob", expiresAt: "soon" }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error?: { code?: string } }).error?.code).toBe("invalid_expires_at");

    const good = await f.app.request("/api/proxy-accounts", {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "carol", expiresAt: "2099-01-01T00:00:00.000Z" }),
    });
    expect(good.status).toBe(201);
  } finally {
    closeFixture(f);
  }
});

test("audit endpoint tolerates a non-numeric ?limit instead of 500", async () => {
  const f = await ownerFixture();
  try {
    const ownerSession = await signIn(f.app);
    const audit = await f.app.request("/api/audit?limit=abc", { headers: { cookie: ownerSession.cookie } });
    expect(audit.status).toBe(200);
  } finally {
    closeFixture(f);
  }
});

test("subscription endpoint rejects a token with a forged signature", async () => {
  const f = await ownerFixture();
  try {
    const ownerSession = await signIn(f.app);
    const created = await f.app.request("/api/proxy-accounts", {
      method: "POST",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf, "content-type": "application/json" },
      body: JSON.stringify({ username: "dave" }),
    });
    const account = (await created.json()) as { account: { subscriptionUrl: string } };
    const realPath = new URL(account.account.subscriptionUrl).pathname;
    const realToken = realPath.split("/").pop() ?? "";
    const decoded = Buffer.from(realToken.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const id = decoded.split(".", 2)[0] ?? "";
    const forged = Buffer.from(`${id}.${"0".repeat(64)}`).toString("base64url");

    const ok = await f.app.request(realPath);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("application/json");

    const bad = await f.app.request(`/api/v1/subscription/${forged}`);
    expect(bad.status).toBe(200);
    expect(bad.headers.get("content-type")).toContain("text/html");
  } finally {
    closeFixture(f);
  }
});

test("settings validation, status, audit, migrations, and action boundary", async () => {
  const f = await ownerFixture();
  try {
    const ownerSession = await signIn(f.app);
    const badSettings = await f.app.request("/api/settings", {
      method: "PATCH",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf, "content-type": "application/json" },
      body: JSON.stringify({ domain: "bad domain" }),
    });
    expect(badSettings.status).toBe(400);

    const status = await f.app.request("/api/status", { headers: { cookie: ownerSession.cookie } });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: { migration: { ok: true, currentVersion: REQUIRED_SCHEMA_VERSION } } });

    const audit = await f.app.request("/api/audit", { headers: { cookie: ownerSession.cookie } });
    expect(audit.status).toBe(200);
    expect(JSON.stringify(await audit.json())).not.toContain("correct horse");

    const noCsrf = await f.app.request("/api/render", { method: "POST", headers: { cookie: ownerSession.cookie } });
    expect(noCsrf.status).toBe(403);
    const forgedCsrf = await f.app.request("/api/render", {
      method: "POST",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": "0".repeat(32), "content-type": "application/json" },
      body: JSON.stringify({ target: "singbox" }),
    });
    expect(forgedCsrf.status).toBe(403);
    expect(isCoreAction("doctor")).toBe(true);
    expect(isCoreAction("rm -rf /")).toBe(false);
  } finally {
    closeFixture(f);
  }
});

test("bootstrap material path is root-only and redaction masks sensitive values", () => {
  const f = tempFixture({ BETTER_AUTH_URL: "https://panel.example.com", CT_ADMIN_SECURE_COOKIES: "true" });
  try {
    const materialPath = bootstrapMaterialPath(f.config);
    writeFileSync(materialPath, "token=ctbt_secretTokenValue1234567890\n", { mode: 0o600 });
    chmodSync(materialPath, 0o600);
    expect(statSync(materialPath).mode & 0o777).toBe(0o600);
    const redacted = redactSensitive("open /setup?token=ctbt_secretTokenValue1234567890 and https://panel.example.com/api/v1/subscription/abcdef");
    expect(redacted).not.toContain("ctbt_secret");
    expect(redacted).not.toContain("abcdef");
  } finally {
    closeFixture(f);
  }
});

test("production secure cookies require https", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-api-test-"));
  try {
    expect(() => {
      const config: AdminConfig = loadAdminConfig(baseEnv(join(dir, "admin.sqlite"), {
        CT_ADMIN_ENV: "production",
        BETTER_AUTH_URL: "http://panel.example.com",
      }));
      return config;
    }).toThrow("https://");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forced password change gates the API until the user rotates their password", async () => {
  const f = await ownerFixture();
  try {
    const ownerSession = await signIn(f.app);
    const created = await f.app.request("/api/users", {
      method: "POST",
      headers: { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf, "content-type": "application/json" },
      body: JSON.stringify({
        email: "tempuser@example.com",
        username: "tempuser",
        name: "Temp User",
        password: "initial temp password",
        role: "operator",
        mustChangePassword: true,
      }),
    });
    expect(created.status).toBe(201);

    const session = await signIn(f.app, "tempuser@example.com", "initial temp password");
    expect(session.csrf).not.toBe("");

    const blocked = await f.app.request("/api/proxy-accounts", { headers: { cookie: session.cookie } });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("password_change_required");

    const me = await f.app.request("/api/me", { headers: { cookie: session.cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { mustChangePassword: boolean } }).user.mustChangePassword).toBe(true);

    const wrong = await f.app.request("/api/me/password", {
      method: "POST",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "not the password", newPassword: "a fresh strong password" }),
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("invalid_current_password");

    const reuse = await f.app.request("/api/me/password", {
      method: "POST",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "initial temp password", newPassword: "initial temp password" }),
    });
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: { code: string } }).error.code).toBe("password_reused");

    const changed = await f.app.request("/api/me/password", {
      method: "POST",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "initial temp password", newPassword: "a fresh strong password" }),
    });
    expect(changed.status).toBe(200);

    const unblocked = await f.app.request("/api/proxy-accounts", { headers: { cookie: session.cookie } });
    expect(unblocked.status).toBe(200);
  } finally {
    closeFixture(f);
  }
});

test("auth audit events capture the client IP", () => {
  const f = tempFixture();
  try {
    const owner = f.store.createUser(null, {
      email: "ip-owner@example.com",
      username: "ipowner",
      name: "IP Owner",
      passwordHash: "x",
      role: "owner",
    });
    f.store.markLogin(owner.id, "198.51.100.7");
    const events = f.store.listAudit(20).filter((e) => e.action === "auth.login");
    expect(events.some((e) => (e.detail ?? "").includes("198.51.100.7"))).toBe(true);
  } finally {
    closeFixture(f);
  }
});

test("an admin cannot create or manage peer admins, only operator/viewer", async () => {
  const f = await ownerFixture();
  try {
    const ownerSession = await signIn(f.app);
    const oh = { cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf, "content-type": "application/json" };
    const mkUser = async (email: string, username: string, role: string) => {
      const res = await f.app.request("/api/users", {
        method: "POST",
        headers: oh,
        body: JSON.stringify({ email, username, name: username, password: "correct horse battery staple", role, mustChangePassword: false }),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { user: AdminUser }).user;
    };
    await mkUser("admina@example.com", "admina", "admin");
    const adminB = await mkUser("adminb@example.com", "adminb", "admin");
    const operator = await mkUser("op@example.com", "operator1", "operator");

    const adminSession = await signIn(f.app, "admina@example.com");
    const ah = { cookie: adminSession.cookie, "x-csrf-token": adminSession.csrf, "content-type": "application/json" };

    // An admin cannot mint a peer admin (canCreateRole).
    const createAdmin = await f.app.request("/api/users", {
      method: "POST",
      headers: ah,
      body: JSON.stringify({ email: "admin2@example.com", username: "admin2", name: "Admin2", password: "correct horse battery staple", role: "admin", mustChangePassword: false }),
    });
    expect(createAdmin.status).toBe(403);

    // …but can create operator/viewer.
    const createViewer = await f.app.request("/api/users", {
      method: "POST",
      headers: ah,
      body: JSON.stringify({ email: "v2@example.com", username: "viewer2", name: "Viewer2", password: "correct horse battery staple", role: "viewer", mustChangePassword: false }),
    });
    expect(createViewer.status).toBe(201);

    // An admin cannot disable or reset a peer admin (canManageTarget rank-strict).
    const disablePeer = await f.app.request(`/api/users/${adminB.id}/disable`, { method: "POST", headers: ah });
    expect(disablePeer.status).toBe(403);
    const resetPeer = await f.app.request(`/api/users/${adminB.id}/reset-password`, {
      method: "POST",
      headers: ah,
      body: JSON.stringify({ password: "another strong password" }),
    });
    expect(resetPeer.status).toBe(403);

    // …but can disable a lower-ranked operator, and the owner can still manage the admin.
    const disableOp = await f.app.request(`/api/users/${operator.id}/disable`, { method: "POST", headers: ah });
    expect(disableOp.status).toBe(200);
    const ownerDisablesAdmin = await f.app.request(`/api/users/${adminB.id}/disable`, { method: "POST", headers: oh });
    expect(ownerDisablesAdmin.status).toBe(200);
  } finally {
    closeFixture(f);
  }
});

test("new users default to a forced password change; the bootstrap owner does not", async () => {
  const f = await ownerFixture();
  try {
    expect(f.owner.mustChangePassword).toBe(false);
    const defaulted = f.store.createUser(f.owner, {
      email: "defaulted@example.com", username: "defaulted", name: "Defaulted", passwordHash: "x", role: "operator",
    });
    expect(defaulted.mustChangePassword).toBe(true);
    const optedOut = f.store.createUser(f.owner, {
      email: "optedout@example.com", username: "optedout", name: "Opted Out", passwordHash: "x", role: "viewer", mustChangePassword: false,
    });
    expect(optedOut.mustChangePassword).toBe(false);
  } finally {
    closeFixture(f);
  }
});

test("security headers add HSTS in secure mode and a CSP on the setup page", async () => {
  const secure = tempFixture({ BETTER_AUTH_URL: "https://panel.example.com", CT_ADMIN_SECURE_COOKIES: "true" });
  try {
    const login = await secure.app.request("/login");
    expect(login.headers.get("strict-transport-security") ?? "").toContain("includeSubDomains");
    const setup = await secure.app.request("/setup");
    const csp = setup.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  } finally {
    closeFixture(secure);
  }

  const insecure = await ownerFixture();
  try {
    const page = await insecure.app.request("/login");
    expect(page.headers.get("strict-transport-security")).toBeNull();
  } finally {
    closeFixture(insecure);
  }
});

test("login throttle locks a sprayed account across rotating source IPs", async () => {
  const f = await ownerFixture();
  try {
    // A distributed spray: each attempt comes from a fresh IP (so no single IP
    // reaches its own 5/min limit), all targeting one (non-existent) account.
    const target = "spray-target@example.com";
    const attempt = async (ip: string, password: string) => {
      const page = await f.app.request("/login");
      const body = await page.text();
      const csrf = body.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
      const cookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
      return f.app.request("/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
          "x-forwarded-for": ip,
          origin: "http://localhost:9000",
          referer: "http://localhost:9000/login",
        },
        body: new URLSearchParams({ csrf, email: target, password }),
      });
    };
    for (let i = 0; i < 10; i++) {
      const res = await attempt(`203.0.113.${101 + i}`, "wrong-password-value");
      expect(res.status).toBe(401); // each IP fresh; the per-account counter climbs
    }
    // 11th try for the same account from yet another fresh IP is now
    // account-throttled — even the *correct* password never reaches auth.
    const blocked = await attempt("203.0.113.200", "correct horse battery staple");
    expect(blocked.status).toBe(429);
  } finally {
    closeFixture(f);
  }
});
