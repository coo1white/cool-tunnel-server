// SPDX-License-Identifier: AGPL-3.0-only
// First-owner bootstrap: one-time expiring token, never passwords.

import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import type { AdminConfig } from "./config";
import type { AdminStorage } from "./storage";
import { validateEmail } from "./config";

export interface BootstrapIssue {
    readonly token: string;
    readonly tokenId: string;
    readonly expiresAt: Date;
    readonly setupPageUrl: string;
}

export function generateBootstrapToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return `ctbt_${Buffer.from(bytes).toString("base64url")}`;
}

export function bootstrapMaterialPath(config: AdminConfig): string {
    return join(dirname(config.dbPath), "bootstrap-setup-url.txt");
}

export async function hashBootstrapToken(token: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
    return Buffer.from(sig).toString("hex");
}

export function tokenFingerprint(token: string): string {
    const bytes = new TextEncoder().encode(token);
    return Bun.hash(bytes).toString(16).padStart(16, "0").slice(0, 16);
}

export async function issueBootstrapToken(storage: AdminStorage, config: AdminConfig): Promise<BootstrapIssue> {
    if (storage.ownerExists()) {
        throw new Error("bootstrap is disabled because an owner account already exists");
    }
    storage.pruneExpiredBootstrapTokens();
    const token = generateBootstrapToken();
    const tokenHash = await hashBootstrapToken(token, config.authSecret);
    const expiresAt = new Date(Date.now() + config.bootstrapTokenTtlMinutes * 60_000);
    const tokenId = storage.createBootstrapToken(tokenHash, expiresAt);
    storage.audit(null, "bootstrap.token_issued", "bootstrap_token", tokenId, {
        tokenFingerprint: tokenFingerprint(token),
        expiresAt: expiresAt.toISOString(),
    });
    return {
        token,
        tokenId,
        expiresAt,
        setupPageUrl: `${config.baseUrl}/setup/bootstrap`,
    };
}

export async function verifyAndConsumeBootstrapToken(
    storage: AdminStorage,
    config: AdminConfig,
    token: string,
): Promise<{ ok: true; tokenId: string } | { ok: false; reason: "owner-exists" | "missing" | "used" | "expired" | "invalid" }> {
    if (storage.ownerExists()) return { ok: false, reason: "owner-exists" };
    if (!/^ctbt_[A-Za-z0-9_-]{32,128}$/.test(token)) return { ok: false, reason: "invalid" };
    const hash = await hashBootstrapToken(token, config.authSecret);
    const status = storage.bootstrapTokenStatus(hash);
    if (status !== "valid") return { ok: false, reason: status };
    const consumed = storage.consumeBootstrapToken(hash);
    if (!consumed) return { ok: false, reason: "used" };
    return { ok: true, tokenId: consumed.id };
}

export async function hashValidBootstrapToken(
    config: AdminConfig,
    token: string,
): Promise<{ ok: true; tokenHash: string } | { ok: false; reason: "invalid" }> {
    if (!/^ctbt_[A-Za-z0-9_-]{32,128}$/.test(token)) return { ok: false, reason: "invalid" };
    return { ok: true, tokenHash: await hashBootstrapToken(token, config.authSecret) };
}

export function bootstrapFailureMessage(reason: "owner-exists" | "missing" | "used" | "expired" | "invalid"): string {
    switch (reason) {
        case "owner-exists":
            return "Bootstrap is disabled because an owner account already exists. Sign in as owner or use an owner session to manage admins.";
        case "missing":
            return "Bootstrap token was not found. Run `ct admin bootstrap` on the server to issue a fresh one-time token.";
        case "used":
            return "Bootstrap token was already used. Run `ct admin bootstrap` to issue a new token if no owner exists.";
        case "expired":
            return "Bootstrap token expired. Run `ct admin bootstrap` to issue a fresh token.";
        case "invalid":
            return "Bootstrap token format is invalid. Paste the full token from `ct admin bootstrap`.";
    }
}

export function constantTimeTokenEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface OwnerInput {
    readonly email: string;
    readonly name: string;
    readonly password: string;
}

export function validateOwnerInput(input: OwnerInput): OwnerInput {
    const email = validateEmail(input.email, "owner email");
    const name = input.name.trim();
    if (name.length < 1 || name.length > 120) {
        throw new Error("owner name must be 1-120 characters");
    }
    if (input.password.length < 12 || input.password.length > 128) {
        throw new Error("owner password must be 12-128 characters");
    }
    return { email, name, password: input.password };
}
