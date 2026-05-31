// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import type { AdminConfig } from "@cool-tunnel/config";
import {
  auditDetail,
  constantTimeEqual,
  generateBootstrapToken,
  hashBootstrapToken,
  maskSubscriptionUrl,
  normalizeDomain,
  normalizeEmail,
  normalizeUsername,
  nowIso,
  randomId,
  randomToken,
  tokenFingerprint,
  validateId,
  validateName,
  validateUrl,
} from "@cool-tunnel/security";
import type {
  AdminRole,
  AdminUser,
  AuditEntry,
  MigrationStatus,
  ProtocolKey,
  ProxyAccount,
  ProxyAccountSecretView,
  ServerSettings,
  StatusSummary,
  UserStatus,
} from "@cool-tunnel/shared";
import {
  canManageTarget,
  DEFAULT_PROTOCOL_KEYS,
  RELEASE_VERSION,
  REQUIRED_SCHEMA_VERSION,
  requireRole,
} from "@cool-tunnel/shared";
import { StoreError } from "./errors.ts";
import { normalizeJsonStringList, normalizeProtocols } from "./helpers.ts";
import type {
  CreateProxyAccountInput,
  CreateUserInput,
  UpdateProxyAccountInput,
  UpdateUserInput,
} from "./types.ts";

export class AdminStore {
  constructor(
    public readonly db: Database,
    public readonly config?: AdminConfig,
  ) {}

  ensureDefaults(config: AdminConfig = this.requireConfig()): void {
    const now = nowIso();
    this.db
      .query(`
      INSERT INTO server_config (
        id, domain, panelDomain, acmeEmail, acmeDirectory,
        antiTrackingHideIp, antiTrackingHideVia, antiTrackingProbeResistance,
        antiTrackingDohResolver, http3Enabled,
        realityPrivateKey, realityPublicKey, realityDestHost, realityShortIds,
        createdAt, updatedAt
      ) VALUES (1, ?, ?, ?, ?, 1, 1, 1, ?, 0, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        domain = excluded.domain,
        panelDomain = excluded.panelDomain,
        acmeEmail = excluded.acmeEmail,
        acmeDirectory = excluded.acmeDirectory,
        antiTrackingDohResolver = excluded.antiTrackingDohResolver,
        realityPrivateKey = COALESCE(NULLIF(server_config.realityPrivateKey, ''), excluded.realityPrivateKey),
        realityPublicKey = COALESCE(NULLIF(server_config.realityPublicKey, ''), excluded.realityPublicKey),
        realityDestHost = COALESCE(NULLIF(server_config.realityDestHost, ''), excluded.realityDestHost),
        realityShortIds = COALESCE(NULLIF(server_config.realityShortIds, ''), excluded.realityShortIds),
        updatedAt = excluded.updatedAt
    `)
      .run(
        config.domain,
        config.panelDomain,
        config.acmeEmail,
        config.acmeDirectory,
        config.antiTrackingDohResolver,
        config.realityPrivateKey,
        config.realityPublicKey,
        config.realityDestHost,
        JSON.stringify(config.realityShortIds),
        now,
        now,
      );
  }

  ownerCount(): number {
    return (
      this.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM user WHERE role = 'owner' AND status = 'active'",
        )
        .get()?.n ?? 0
    );
  }

  hasOwner(): boolean {
    return this.ownerCount() > 0;
  }

  userCount(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user").get()?.n ?? 0;
  }

  listUsers(): AdminUser[] {
    return this.db
      .query<Record<string, unknown>, []>(
        "SELECT * FROM user ORDER BY role = 'owner' DESC, createdAt DESC",
      )
      .all()
      .map(rowToUser);
  }

  getUser(id: string): AdminUser | null {
    if (!validateId(id)) return null;
    const row = this.db
      .query<Record<string, unknown>, [string]>("SELECT * FROM user WHERE id = ?")
      .get(id);
    return row ? rowToUser(row) : null;
  }

  getUserByEmail(email: string): AdminUser | null {
    const normalized = normalizeEmail(email);
    const row = this.db
      .query<Record<string, unknown>, [string]>("SELECT * FROM user WHERE email = ?")
      .get(normalized);
    return row ? rowToUser(row) : null;
  }

  getOwnPasswordHash(userId: string): string | null {
    if (!validateId(userId)) return null;
    const row = this.db
      .query<{ password: string | null }, [string]>(
        "SELECT password FROM account WHERE userId = ? AND providerId = 'credential'",
      )
      .get(userId);
    return row?.password ?? null;
  }

  changeOwnPassword(
    userId: string,
    passwordHash: string,
    keepSessionToken: string,
    ip?: string | null,
  ): void {
    const ts = nowIso();
    this.db
      .query(
        "UPDATE account SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = 'credential'",
      )
      .run(passwordHash, ts, userId);
    this.db
      .query("UPDATE user SET mustChangePassword = 0, updatedAt = ? WHERE id = ?")
      .run(ts, userId);
    // Revoke every other session for this user; keep the caller's current one so
    // they stay signed in after rotating a forced/temporary password.
    this.db
      .query("DELETE FROM session WHERE userId = ? AND token != ?")
      .run(userId, keepSessionToken);
    this.audit(userId, "user.password_changed", "user", userId, ip ? { ip } : {});
  }

  createUser(actor: AdminUser | null, input: CreateUserInput): AdminUser {
    return this.db.transaction(() => this.insertUser(actor, input))();
  }

  createFirstOwner(input: CreateUserInput, tokenHash: string): AdminUser {
    return this.db.transaction(() => {
      if (this.hasOwner())
        throw new StoreError(
          "bootstrap_disabled",
          "Bootstrap is disabled because an owner already exists.",
          403,
        );
      const token = this.consumeBootstrapTokenHash(tokenHash);
      if (!token.ok)
        throw new StoreError("invalid_bootstrap_token", bootstrapFailureMessage(token.reason), 403);
      if (input.role !== "owner")
        throw new StoreError("invalid_role", "First bootstrap user must be an owner.");
      // The bootstrap owner chooses their own password in the setup form, so they
      // are never force-rotated. Set this explicitly rather than relying on the
      // (now secure-by-default) insertUser fallback.
      const user = this.insertUser(null, { ...input, mustChangePassword: false });
      this.audit(user.id, "bootstrap.owner.created", "user", user.id, { username: user.username });
      return user;
    })();
  }

  updateUser(actor: AdminUser, id: string, input: UpdateUserInput): AdminUser {
    const target = this.requireUser(id);
    if (!canManageTarget(actor, target))
      throw new StoreError("forbidden", "You do not have permission to manage this user.", 403);
    const nextRole = input.role === undefined ? target.role : requireRole(input.role);
    const nextStatus = input.status ?? target.status;
    if (nextStatus !== "active" && nextStatus !== "disabled")
      throw new StoreError("invalid_status", "Choose a valid status.");
    if (nextRole === "owner" && actor.role !== "owner")
      throw new StoreError("forbidden", "Only owners can grant owner role.", 403);
    this.assertLastOwnerPreserved(target, nextRole, nextStatus);
    const email = input.email === undefined ? target.email : normalizeEmail(input.email);
    const username =
      input.username === undefined ? target.username : normalizeUsername(input.username);
    const name = input.name === undefined ? target.name : input.name.trim();
    if (!validateName(name)) throw new StoreError("invalid_name", "Name is required.");
    const ts = nowIso();
    try {
      this.db
        .query(`
        UPDATE user
        SET email = ?, username = ?, name = ?, role = ?, status = ?, mustChangePassword = ?,
            disabledAt = CASE WHEN ? = 'disabled' THEN COALESCE(disabledAt, ?) ELSE NULL END,
            updatedAt = ?
        WHERE id = ?
      `)
        .run(
          email,
          username,
          name,
          nextRole,
          nextStatus,
          input.mustChangePassword === undefined
            ? target.mustChangePassword
              ? 1
              : 0
            : input.mustChangePassword
              ? 1
              : 0,
          nextStatus,
          ts,
          ts,
          id,
        );
    } catch (e) {
      throw uniqueOrDatabaseError(
        e,
        "duplicate_user",
        "A user with that email or username already exists.",
      );
    }
    if (nextStatus === "disabled") this.db.query("DELETE FROM session WHERE userId = ?").run(id);
    const updated = this.requireUser(id);
    this.audit(actor.id, "user.updated", "user", id, {
      role: updated.role,
      status: updated.status,
      changed: Object.keys(input).sort(),
    });
    return updated;
  }

  disableUser(actor: AdminUser, id: string): AdminUser {
    return this.updateUser(actor, id, { status: "disabled" });
  }

  enableUser(actor: AdminUser, id: string): AdminUser {
    return this.updateUser(actor, id, { status: "active" });
  }

  resetPassword(actor: AdminUser, id: string, passwordHash: string): AdminUser {
    const target = this.requireUser(id);
    if (!canManageTarget(actor, target))
      throw new StoreError("forbidden", "You do not have permission to reset this password.", 403);
    const ts = nowIso();
    this.db
      .query(
        "UPDATE account SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = 'credential'",
      )
      .run(passwordHash, ts, id);
    this.db.query("UPDATE user SET mustChangePassword = 1, updatedAt = ? WHERE id = ?").run(ts, id);
    this.db.query("DELETE FROM session WHERE userId = ?").run(id);
    const updated = this.requireUser(id);
    this.audit(actor.id, "user.password_reset", "user", id, {});
    return updated;
  }

  deleteUser(actor: AdminUser, id: string): void {
    const target = this.requireUser(id);
    if (actor.id === target.id)
      throw new StoreError("cannot_delete_self", "You cannot delete your own account.");
    if (actor.role !== "owner")
      throw new StoreError("forbidden", "Only owners can delete users.", 403);
    this.assertLastOwnerPreserved(target, "__deleted__" as AdminRole, "disabled");
    this.db.query("DELETE FROM user WHERE id = ?").run(id);
    this.audit(actor.id, "user.deleted", "user", id, {
      targetRole: target.role,
      targetUsername: target.username,
    });
  }

  markLogin(userId: string, ip?: string | null): void {
    const ts = nowIso();
    this.db
      .query("UPDATE user SET lastLoginAt = ?, updatedAt = ? WHERE id = ?")
      .run(ts, ts, userId);
    this.audit(userId, "auth.login", "user", userId, ip ? { ip } : {});
  }

  async createBootstrapToken(
    config: Pick<AdminConfig, "authSecret">,
    ttlMinutes = 15,
  ): Promise<{ token: string; expiresAt: string; pathHint: string }> {
    if (this.hasOwner())
      throw new StoreError(
        "bootstrap_disabled",
        "Bootstrap is disabled because an owner already exists.",
        403,
      );
    this.pruneExpiredBootstrapTokens();
    const token = generateBootstrapToken();
    const tokenHash = await hashBootstrapToken(token, config.authSecret);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    this.db
      .query(
        "INSERT INTO bootstrap_token (id, tokenHash, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, NULL, ?)",
      )
      .run(randomId(), tokenHash, expiresAt, nowIso());
    this.audit(null, "bootstrap.token.created", "bootstrap_token", null, {
      tokenFingerprint: tokenFingerprint(token),
      expiresAt,
    });
    return { token, expiresAt, pathHint: "/setup?token=<redacted>" };
  }

  consumeBootstrapTokenHash(
    tokenHash: string,
  ): { ok: true; tokenId: string } | { ok: false; reason: "missing" | "used" | "expired" } {
    const row = this.db
      .query<Record<string, unknown>, [string]>("SELECT * FROM bootstrap_token WHERE tokenHash = ?")
      .get(tokenHash);
    if (!row) return { ok: false, reason: "missing" };
    if (row.usedAt !== null) return { ok: false, reason: "used" };
    if (Date.parse(String(row.expiresAt)) <= Date.now()) return { ok: false, reason: "expired" };
    this.db
      .query("UPDATE bootstrap_token SET usedAt = ? WHERE id = ? AND usedAt IS NULL")
      .run(nowIso(), String(row.id));
    return { ok: true, tokenId: String(row.id) };
  }

  pruneExpiredBootstrapTokens(): void {
    this.db
      .query("DELETE FROM bootstrap_token WHERE expiresAt <= ? OR usedAt IS NOT NULL")
      .run(nowIso());
  }

  /**
   * Deletes audit_log rows whose createdAt is older than `cutoffIso`.
   * Returns the number of rows deleted. Used by the BullMQ audit
   * retention job (apps/api/src/jobs/audit-retention.ts) and exposed
   * here so the SQL stays in the audited write-path layer.
   *
   * Called daily by default; safe to call manually for ad-hoc cleanup.
   */
  pruneAuditLogOlderThan(cutoffIso: string): number {
    const result = this.db.query("DELETE FROM audit_log WHERE createdAt < ?").run(cutoffIso);
    return Number((result as { changes?: number | bigint }).changes ?? 0);
  }

  listProxyAccounts(): ProxyAccount[] {
    return this.db
      .query<Record<string, unknown>, []>("SELECT * FROM proxy_account ORDER BY createdAt DESC")
      .all()
      .map((row) => rowToProxyAccount(row, this.panelDomain(), this.config?.authSecret ?? ""));
  }

  getProxyAccount(id: string): ProxyAccountSecretView | null {
    if (!validateId(id)) return null;
    const row = this.db
      .query<Record<string, unknown>, [string]>("SELECT * FROM proxy_account WHERE id = ?")
      .get(id);
    return row
      ? rowToProxyAccountSecret(row, this.panelDomain(), this.config?.authSecret ?? "")
      : null;
  }

  // Returns the account with its secret subscription URL/uuid and records an
  // audit event — the subscription token is masked in the UI by default, so a
  // deliberate reveal is logged.
  revealProxySubscription(actor: AdminUser, id: string): ProxyAccountSecretView {
    const account = this.getProxyAccount(id);
    if (!account) throw new StoreError("not_found", "Proxy account not found.", 404);
    this.audit(actor.id, "proxy_account.subscription_revealed", "proxy_account", id, {
      username: account.username,
    });
    return account;
  }

  createProxyAccount(actor: AdminUser, input: CreateProxyAccountInput): ProxyAccountSecretView {
    const id = randomId();
    const uuid = crypto.randomUUID();
    const subscriptionSecret = randomToken(32);
    const ts = nowIso();
    const normalized = normalizeProxyInput(input);
    this.db
      .query(`
      INSERT INTO proxy_account (
        id, username, uuid, previousUuid, previousUuidValidUntil, subscriptionSecret, label, enabled,
        clientDefaultLocalPort, enabledProtocols, expiresAt, lastSeenAt, metadata, createdAt, updatedAt
      ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `)
      .run(
        id,
        normalized.username,
        uuid,
        subscriptionSecret,
        normalized.label,
        normalized.enabled ? 1 : 0,
        normalized.clientDefaultLocalPort,
        JSON.stringify(normalized.enabledProtocols),
        normalized.expiresAt,
        ts,
        ts,
      );
    const created = this.getProxyAccount(id);
    if (!created) throw new StoreError("database_error", "Proxy account creation failed.", 500);
    this.audit(actor.id, "proxy_account.created", "proxy_account", id, {
      username: created.username,
      status: created.status,
    });
    return created;
  }

  updateProxyAccount(actor: AdminUser, id: string, input: UpdateProxyAccountInput): ProxyAccount {
    const current = this.getProxyAccount(id);
    if (!current) throw new StoreError("not_found", "Proxy account not found.", 404);
    const normalized = normalizeProxyInput({
      username: input.username ?? current.username,
      label: input.label === undefined ? current.label : input.label,
      enabled: input.enabled ?? current.enabled,
      clientDefaultLocalPort: input.clientDefaultLocalPort ?? current.clientDefaultLocalPort,
      enabledProtocols: input.enabledProtocols ?? current.enabledProtocols,
      expiresAt: input.expiresAt === undefined ? current.expiresAt : input.expiresAt,
    });
    const ts = nowIso();
    this.db
      .query(`
      UPDATE proxy_account
      SET username = ?, label = ?, enabled = ?, clientDefaultLocalPort = ?, enabledProtocols = ?, expiresAt = ?, updatedAt = ?
      WHERE id = ?
    `)
      .run(
        normalized.username,
        normalized.label,
        normalized.enabled ? 1 : 0,
        normalized.clientDefaultLocalPort,
        JSON.stringify(normalized.enabledProtocols),
        normalized.expiresAt,
        ts,
        id,
      );
    const updated = this.getProxyAccount(id);
    if (!updated) throw new StoreError("not_found", "Proxy account not found.", 404);
    this.audit(actor.id, "proxy_account.updated", "proxy_account", id, {
      username: updated.username,
      changed: Object.keys(input).sort(),
    });
    return updated;
  }

  setProxyEnabled(actor: AdminUser, id: string, enabled: boolean): ProxyAccount {
    return this.updateProxyAccount(actor, id, { enabled });
  }

  regenerateProxyUuid(actor: AdminUser, id: string): ProxyAccountSecretView {
    const current = this.getProxyAccount(id);
    if (!current) throw new StoreError("not_found", "Proxy account not found.", 404);
    if (!current.uuid)
      throw new StoreError("database_error", "Proxy account is missing its UUID.", 500);
    const uuid = crypto.randomUUID();
    const secret = randomToken(32);
    const ts = nowIso();
    const previousValidUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    this.db
      .query(`
      UPDATE proxy_account
      SET uuid = ?, previousUuid = ?, previousUuidValidUntil = ?, subscriptionSecret = ?, updatedAt = ?
      WHERE id = ?
    `)
      .run(uuid, current.uuid, previousValidUntil, secret, ts, id);
    const updated = this.getProxyAccount(id);
    if (!updated) throw new StoreError("not_found", "Proxy account not found.", 404);
    this.audit(actor.id, "proxy_account.uuid_rotated", "proxy_account", id, {
      username: updated.username,
      previousUuidValidUntil: previousValidUntil,
    });
    return updated;
  }

  deleteProxyAccount(actor: AdminUser, id: string): void {
    const current = this.getProxyAccount(id);
    if (!current) throw new StoreError("not_found", "Proxy account not found.", 404);
    this.db.query("DELETE FROM proxy_account WHERE id = ?").run(id);
    this.audit(actor.id, "proxy_account.deleted", "proxy_account", id, {
      username: current.username,
    });
  }

  getSettings(): ServerSettings {
    const existing = this.db
      .query<Record<string, unknown>, []>("SELECT * FROM server_config WHERE id = 1")
      .get();
    if (existing) return rowToSettings(existing);
    this.ensureDefaults();
    const row = this.db
      .query<Record<string, unknown>, []>("SELECT * FROM server_config WHERE id = 1")
      .get();
    if (!row) throw new StoreError("settings_missing", "Server settings are missing.", 500);
    return rowToSettings(row);
  }

  updateSettings(actor: AdminUser, input: Partial<ServerSettings>): ServerSettings {
    const current = this.getSettings();
    let next: {
      domain: string;
      panelDomain: string;
      acmeEmail: string;
      acmeDirectory: string;
      antiTrackingHideIp: boolean;
      antiTrackingHideVia: boolean;
      antiTrackingProbeResistance: boolean;
      antiTrackingDohResolver: string;
      http3Enabled: false;
      realityDestHost: string;
      realityShortIds: string[];
    };
    try {
      next = {
        domain:
          input.domain === undefined ? current.domain : normalizeDomain(input.domain, "DOMAIN"),
        panelDomain:
          input.panelDomain === undefined
            ? current.panelDomain
            : normalizeDomain(input.panelDomain, "PANEL_DOMAIN"),
        acmeEmail:
          input.acmeEmail === undefined ? current.acmeEmail : normalizeEmail(input.acmeEmail),
        acmeDirectory: input.acmeDirectory ?? current.acmeDirectory,
        antiTrackingHideIp: input.antiTrackingHideIp ?? current.antiTrackingHideIp,
        antiTrackingHideVia: input.antiTrackingHideVia ?? current.antiTrackingHideVia,
        antiTrackingProbeResistance:
          input.antiTrackingProbeResistance ?? current.antiTrackingProbeResistance,
        antiTrackingDohResolver: input.antiTrackingDohResolver ?? current.antiTrackingDohResolver,
        http3Enabled: false,
        realityDestHost:
          input.realityDestHost === undefined
            ? current.realityDestHost
            : normalizeDomain(input.realityDestHost, "REALITY_DEST_HOST"),
        realityShortIds: input.realityShortIds ?? current.realityShortIds,
      };
    } catch (error) {
      throw new StoreError(
        "invalid_settings",
        error instanceof Error ? error.message : "Settings validation failed.",
      );
    }
    if (!validateUrl(next.acmeDirectory, ["https:"]))
      throw new StoreError("invalid_acme_directory", "ACME directory must be an https URL.");
    if (!validateUrl(next.antiTrackingDohResolver, ["https:"]))
      throw new StoreError("invalid_doh_resolver", "DoH resolver must be an https URL.");
    const ts = nowIso();
    this.db
      .query(`
      UPDATE server_config
      SET domain = ?, panelDomain = ?, acmeEmail = ?, acmeDirectory = ?,
          antiTrackingHideIp = ?, antiTrackingHideVia = ?, antiTrackingProbeResistance = ?,
          antiTrackingDohResolver = ?, http3Enabled = ?, realityDestHost = ?, realityShortIds = ?, updatedAt = ?
      WHERE id = 1
    `)
      .run(
        next.domain,
        next.panelDomain,
        next.acmeEmail,
        next.acmeDirectory,
        next.antiTrackingHideIp ? 1 : 0,
        next.antiTrackingHideVia ? 1 : 0,
        next.antiTrackingProbeResistance ? 1 : 0,
        next.antiTrackingDohResolver,
        0,
        next.realityDestHost,
        JSON.stringify(next.realityShortIds),
        ts,
      );
    const updated = this.getSettings();
    this.audit(actor.id, "settings.updated", "server_config", "1", {
      changed: Object.keys(input).sort(),
    });
    return updated;
  }

  listAudit(limit = 100): AuditEntry[] {
    const bounded = Math.max(1, Math.min(250, Math.floor(limit)));
    return this.db
      .query<Record<string, unknown>, [number]>("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(bounded)
      .map(rowToAudit);
  }

  audit(
    actorUserId: string | null,
    action: string,
    targetType: string | null,
    targetId: string | null,
    detail: Record<string, unknown>,
  ): void {
    this.db
      .query(
        "INSERT INTO audit_log (action, actorUserId, targetType, targetId, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(action, actorUserId, targetType, targetId, auditDetail(detail), nowIso());
  }

  migrationStatus(): MigrationStatus {
    const row = this.db
      .query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get();
    const currentVersion = Number(row?.value ?? "0");
    return {
      currentVersion,
      requiredVersion: REQUIRED_SCHEMA_VERSION,
      ok: currentVersion >= REQUIRED_SCHEMA_VERSION,
      message:
        currentVersion >= REQUIRED_SCHEMA_VERSION
          ? "SQLite schema is current."
          : "Run `ct admin migrate` before starting the admin runtime.",
    };
  }

  statusSummary(): StatusSummary {
    const accounts = this.listProxyAccounts();
    const settings = this.getSettings();
    return {
      version: RELEASE_VERSION,
      hasOwner: this.hasOwner(),
      userCount: this.userCount(),
      proxyAccountCount: accounts.length,
      activeProxyAccountCount: accounts.filter((account) => account.status === "active").length,
      settingsReady: settings.domain !== "" && settings.realityPublicKey !== "",
      migration: this.migrationStatus(),
      // Only the two services the API can vouch for from inside the process.
      // Runtime container health (caddy, singbox, admin-web) is merged in by
      // the API layer via the Docker socket; the retired rust-core daemon is
      // intentionally gone.
      services: [
        { name: "api", status: "running", detail: "Hono admin API is responding." },
        {
          name: "sqlite",
          status: "running",
          detail: "SQLite database opened with migrations applied.",
        },
      ],
    };
  }

  subscriptionToken(
    account: { id: string; subscriptionSecret: string | null },
    secret = this.config?.authSecret ?? "",
  ): string | null {
    if (!secret) return null;
    const signed = account.subscriptionSecret
      ? `${account.id}.${account.subscriptionSecret}`
      : account.id;
    const sig = createHmac("sha256", secret).update(signed).digest("hex");
    return Buffer.from(`${account.id}.${sig}`).toString("base64url");
  }

  async resolveSubscriptionToken(token: string): Promise<Record<string, unknown> | null> {
    let decoded = "";
    try {
      decoded = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    } catch {
      return null;
    }
    if (!decoded.includes(".") || !this.config?.authSecret) return null;
    const [id, sig] = decoded.split(".", 2);
    if (!validateId(id)) return null;
    const row = this.db
      .query<Record<string, unknown>, [string]>("SELECT * FROM proxy_account WHERE id = ?")
      .get(id);
    if (!row) return null;
    const secret = String(row.subscriptionSecret ?? "");
    const signed = secret ? `${id}.${secret}` : id;
    const expected = createHmac("sha256", this.config.authSecret).update(signed).digest("hex");
    if (!constantTimeEqual(expected, sig ?? "")) return null;
    return row;
  }

  private panelDomain(): string {
    return this.getSettings().panelDomain;
  }

  private requireConfig(): AdminConfig {
    if (!this.config)
      throw new StoreError("config_required", "Admin config is required for this operation.", 500);
    return this.config;
  }

  private requireUser(id: string): AdminUser {
    const user = this.getUser(id);
    if (!user) throw new StoreError("not_found", "User not found.", 404);
    return user;
  }

  private insertUser(actor: AdminUser | null, input: CreateUserInput): AdminUser {
    const email = normalizeEmail(input.email);
    const username = normalizeUsername(input.username || email.split("@")[0] || "");
    const name = input.name.trim();
    if (!validateName(name)) throw new StoreError("invalid_name", "Name is required.");
    const role = requireRole(input.role);
    if (actor && role === "owner" && actor.role !== "owner")
      throw new StoreError("forbidden", "Only owners can create owner accounts.", 403);
    const id = randomId();
    const ts = nowIso();
    try {
      this.db
        .query(`
        INSERT INTO user (
          id, name, email, emailVerified, image, createdAt, updatedAt, username, role, status, mustChangePassword
        ) VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?, 'active', ?)
      `)
        .run(id, name, email, ts, ts, username, role, input.mustChangePassword === false ? 0 : 1);
      this.db
        .query(`
        INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
        VALUES (?, ?, 'credential', ?, ?, ?, ?)
      `)
        .run(randomId(), id, id, input.passwordHash, ts, ts);
    } catch (e) {
      throw uniqueOrDatabaseError(
        e,
        "duplicate_user",
        "A user with that email or username already exists.",
      );
    }
    const user = this.requireUser(id);
    this.audit(actor?.id ?? null, "user.created", "user", user.id, {
      username: user.username,
      role: user.role,
    });
    return user;
  }

  private assertLastOwnerPreserved(
    target: AdminUser,
    nextRole: AdminRole,
    nextStatus: UserStatus,
  ): void {
    if (target.role !== "owner" || target.status !== "active") return;
    if (nextRole === "owner" && nextStatus === "active") return;
    if (this.ownerCount() <= 1)
      throw new StoreError(
        "last_owner",
        "You cannot remove, disable, or demote the last active owner.",
      );
  }
}

function uniqueOrDatabaseError(e: unknown, code: string, message: string): StoreError {
  const msg = String(e instanceof Error ? e.message : e);
  if (msg.includes("UNIQUE")) return new StoreError(code, message, 409);
  return new StoreError("database_error", "The account database rejected the change.", 500);
}

function bootstrapFailureMessage(reason: "missing" | "used" | "expired"): string {
  switch (reason) {
    case "missing":
      return "Bootstrap token is invalid or expired.";
    case "used":
      return "Bootstrap token has already been used.";
    case "expired":
      return "Bootstrap token is invalid or expired.";
  }
}

function rowToUser(row: Record<string, unknown>): AdminUser {
  return {
    id: String(row.id),
    email: String(row.email),
    username: String(row.username ?? ""),
    name: String(row.name),
    role: requireRole(row.role),
    status: row.status === "disabled" ? "disabled" : "active",
    mustChangePassword: Number(row.mustChangePassword ?? 0) === 1,
    twoFactorEnabled: Number(row.twoFactorEnabled ?? 0) === 1,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    lastLoginAt:
      row.lastLoginAt === null || row.lastLoginAt === undefined ? null : String(row.lastLoginAt),
    disabledAt:
      row.disabledAt === null || row.disabledAt === undefined ? null : String(row.disabledAt),
  };
}

function rowToProxyAccount(
  row: Record<string, unknown>,
  panelDomain: string,
  secret: string,
): ProxyAccount {
  const enabled = Number(row.enabled ?? 0) === 1;
  const expiresAt =
    row.expiresAt === null || row.expiresAt === undefined ? null : String(row.expiresAt);
  const expired = expiresAt !== null && Date.parse(expiresAt) <= Date.now();
  const subscriptionUrl = subscriptionUrlFor(row, panelDomain, secret);
  return {
    id: String(row.id),
    username: String(row.username),
    label: row.label === null || row.label === undefined ? null : String(row.label),
    status: !enabled ? "disabled" : expired ? "expired" : "active",
    enabled,
    clientDefaultLocalPort: Number(row.clientDefaultLocalPort ?? 1080),
    enabledProtocols: normalizeProtocols(row.enabledProtocols),
    expiresAt,
    lastSeenAt:
      row.lastSeenAt === null || row.lastSeenAt === undefined ? null : String(row.lastSeenAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    previousUuidValidUntil:
      row.previousUuidValidUntil === null || row.previousUuidValidUntil === undefined
        ? null
        : String(row.previousUuidValidUntil),
    subscriptionUrlMasked: maskSubscriptionUrl(subscriptionUrl),
  };
}

function rowToProxyAccountSecret(
  row: Record<string, unknown>,
  panelDomain: string,
  secret: string,
): ProxyAccountSecretView {
  return {
    ...rowToProxyAccount(row, panelDomain, secret),
    uuid: String(row.uuid),
    previousUuid:
      row.previousUuid === null || row.previousUuid === undefined ? null : String(row.previousUuid),
    subscriptionUrl: subscriptionUrlFor(row, panelDomain, secret),
  };
}

function subscriptionUrlFor(
  row: Record<string, unknown>,
  panelDomain: string,
  secret: string,
): string | null {
  const id = String(row.id ?? "");
  if (!id || !secret) return null;
  const subscriptionSecret =
    row.subscriptionSecret === null || row.subscriptionSecret === undefined
      ? null
      : String(row.subscriptionSecret);
  const signed = subscriptionSecret ? `${id}.${subscriptionSecret}` : id;
  const sig = createHmac("sha256", secret).update(signed).digest("hex");
  const token = Buffer.from(`${id}.${sig}`).toString("base64url");
  if (!token) return null;
  return `https://${panelDomain}/api/v1/subscription/${token}`;
}

function normalizeProxyInput(input: CreateProxyAccountInput): Required<CreateProxyAccountInput> {
  const username = normalizeUsername(input.username);
  const label =
    input.label === undefined || input.label === null || input.label.trim() === ""
      ? null
      : input.label.trim();
  const enabled = input.enabled ?? true;
  const clientDefaultLocalPort = input.clientDefaultLocalPort ?? 1080;
  if (
    !Number.isInteger(clientDefaultLocalPort) ||
    clientDefaultLocalPort < 1024 ||
    clientDefaultLocalPort > 65535
  ) {
    throw new StoreError("invalid_port", "Local SOCKS port must be 1024-65535.");
  }
  let expiresAt: string | null = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== "") {
    const parsed = Date.parse(input.expiresAt);
    if (Number.isNaN(parsed))
      throw new StoreError("invalid_expires_at", "Expiry must be a valid date.");
    expiresAt = new Date(parsed).toISOString();
  }
  return {
    username,
    label,
    enabled,
    clientDefaultLocalPort,
    enabledProtocols: input.enabledProtocols?.filter(
      (p): p is ProtocolKey => p === "vless_reality",
    ) ?? [...DEFAULT_PROTOCOL_KEYS],
    expiresAt,
  };
}

function rowToSettings(row: Record<string, unknown>): ServerSettings {
  return {
    domain: String(row.domain),
    panelDomain: String(row.panelDomain),
    acmeEmail: String(row.acmeEmail),
    acmeDirectory: String(row.acmeDirectory),
    antiTrackingHideIp: Number(row.antiTrackingHideIp) === 1,
    antiTrackingHideVia: Number(row.antiTrackingHideVia) === 1,
    antiTrackingProbeResistance: Number(row.antiTrackingProbeResistance) === 1,
    antiTrackingDohResolver: String(row.antiTrackingDohResolver),
    http3Enabled: false,
    realityPublicKey: String(row.realityPublicKey),
    realityDestHost: String(row.realityDestHost),
    realityShortIds: normalizeJsonStringList(row.realityShortIds),
    lastCaddyfileHash:
      row.lastCaddyfileHash === null || row.lastCaddyfileHash === undefined
        ? null
        : String(row.lastCaddyfileHash),
    lastRenderedAt:
      row.lastRenderedAt === null || row.lastRenderedAt === undefined
        ? null
        : String(row.lastRenderedAt),
    updatedAt: String(row.updatedAt),
  };
}

function rowToAudit(row: Record<string, unknown>): AuditEntry {
  return {
    id: Number(row.id),
    action: String(row.action),
    actorUserId:
      row.actorUserId === null || row.actorUserId === undefined ? null : String(row.actorUserId),
    targetType:
      row.targetType === null || row.targetType === undefined ? null : String(row.targetType),
    targetId: row.targetId === null || row.targetId === undefined ? null : String(row.targetId),
    detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
    createdAt: String(row.createdAt),
  };
}
