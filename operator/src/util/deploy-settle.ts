// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/deploy-settle.ts — post-deploy convergence gate.
//
// Docker Compose returns as soon as containers are created. On a small
// VPS, healthchecks can still report "starting" for panel/caddy/singbox
// for another few seconds, and the credential-lock guard can observe the
// old singbox.json before the panel-side render path has settled. Keep
// install/update patient and self-healing here instead of making the
// operator run the recovery commands by hand.

import { $, capture, type ShResult } from "./sh";
import { waitFor } from "./wait";
import { redactSensitive } from "./redact";
import {
    credentialLockCheck,
    readSingboxConfigCommand,
    renderSingboxConfig,
    restartSingbox,
} from "./credential-control";

export const CORE_DEPLOY_SERVICES = ["panel", "caddy", "singbox"] as const;

export interface ServiceHealthRow {
    readonly service: string;
    readonly state: string;
    readonly health: string;
}

export interface DeploySettleOptions {
    readonly services?: readonly string[];
    readonly maxAttempts?: number;
    readonly intervalMs?: number;
    readonly log?: (message: string) => void;
}

export interface ServiceSettleResult {
    readonly ok: boolean;
    readonly services: readonly string[];
    readonly rows: Map<string, ServiceHealthRow> | null;
    readonly unready: string;
}

export interface CredentialLockAttempt {
    readonly phase: "initial" | "after-singbox-restart";
    readonly render: ShResult;
    readonly guard?: ShResult;
}

export interface CredentialLockSettleResult {
    readonly ok: boolean;
    readonly attempts: readonly CredentialLockAttempt[];
    readonly restart?: ShResult;
    readonly singboxReady?: ServiceSettleResult;
}

export interface DeploymentSettleResult {
    readonly ok: boolean;
    readonly services: ServiceSettleResult;
    readonly credentialLock?: CredentialLockSettleResult;
}

export function parseComposePsRows(output: string): Map<string, ServiceHealthRow> {
    const rows = new Map<string, ServiceHealthRow>();
    for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            const service = parsed["Service"];
            if (typeof service !== "string" || service === "" || rows.has(service)) continue;
            rows.set(service, {
                service,
                state: String(parsed["State"] ?? ""),
                health: String(parsed["Health"] ?? ""),
            });
        } catch {
            // Ignore malformed compose rows; the caller reports missing services.
        }
    }
    return rows;
}

export function serviceReady(row: ServiceHealthRow | undefined): boolean {
    if (!row) return false;
    return row.state === "running" && (row.health === "" || row.health === "healthy");
}

export function describeUnreadyServices(
    rows: Map<string, ServiceHealthRow>,
    services: readonly string[],
): string {
    const out: string[] = [];
    for (const service of services) {
        const row = rows.get(service);
        if (!row) {
            out.push(`${service}=missing`);
        } else if (!serviceReady(row)) {
            out.push(`${service}=${row.state}${row.health ? `/${row.health}` : ""}`);
        }
    }
    return out.join(",");
}

async function composeRows(): Promise<Map<string, ServiceHealthRow> | null> {
    const ps = await capture($`docker compose ps --format json`);
    if (!ps.ok || !ps.stdout.trim()) return null;
    return parseComposePsRows(ps.stdout);
}

export async function checkServicesReady(services: readonly string[] = CORE_DEPLOY_SERVICES): Promise<ServiceSettleResult> {
    const rows = await composeRows();
    if (!rows) {
        return {
            ok: false,
            services,
            rows: null,
            unready: services.map((service) => `${service}=unknown`).join(","),
        };
    }
    const unready = describeUnreadyServices(rows, services);
    return {
        ok: unready === "",
        services,
        rows,
        unready,
    };
}

export async function waitForServicesReady(opts: DeploySettleOptions = {}): Promise<boolean> {
    const result = await waitForServicesReadyReport(opts);
    return result.ok;
}

export async function waitForServicesReadyReport(opts: DeploySettleOptions = {}): Promise<ServiceSettleResult> {
    const services = opts.services ?? CORE_DEPLOY_SERVICES;
    let last = await checkServicesReady(services);
    const ok = await waitFor({
        label: `compose health (${services.join(",")})`,
        maxAttempts: opts.maxAttempts ?? 36,
        intervalMs: opts.intervalMs ?? 5000,
        probe: async () => {
            last = await checkServicesReady(services);
            if (last.ok) return true;
            opts.log?.(`waiting for containers: ${last.unready}`);
            return false;
        },
        progressEveryMs: 15_000,
        onTimeout: () => undefined,
    });
    return ok ? { ...last, ok: true, unready: "" } : last;
}

export async function settleCredentialLock(opts: DeploySettleOptions = {}): Promise<CredentialLockSettleResult> {
    const attempts: CredentialLockAttempt[] = [];
    const initial = await credentialLockAttempt("initial");
    attempts.push(initial);
    if (credentialAttemptOk(initial)) return { ok: true, attempts };

    opts.log?.(credentialAttemptLogMessage(initial));
    const restart = await restartSingbox();
    if (!restart.ok) return { ok: false, attempts, restart };

    const singboxReady = await waitForServicesReadyReport({
        ...opts,
        services: ["singbox"],
        maxAttempts: Math.min(opts.maxAttempts ?? 24, 24),
    });
    if (!singboxReady.ok) return { ok: false, attempts, restart, singboxReady };

    const afterRestart = await credentialLockAttempt("after-singbox-restart");
    attempts.push(afterRestart);
    return {
        ok: credentialAttemptOk(afterRestart),
        attempts,
        restart,
        singboxReady,
    };
}

export async function settleDeployment(opts: DeploySettleOptions = {}): Promise<DeploymentSettleResult> {
    const services = await waitForServicesReadyReport(opts);
    if (!services.ok) return { ok: false, services };

    const credentialLock = await settleCredentialLock(opts);
    return {
        ok: credentialLock.ok,
        services,
        credentialLock,
    };
}

async function credentialLockAttempt(phase: CredentialLockAttempt["phase"]): Promise<CredentialLockAttempt> {
    const render = await renderSingboxConfig();
    if (!render.ok) return { phase, render };
    return { phase, render, guard: await credentialLockCheck() };
}

function credentialAttemptOk(attempt: CredentialLockAttempt): boolean {
    return attempt.render.ok && attempt.guard?.ok === true;
}

function credentialAttemptLogMessage(attempt: CredentialLockAttempt): string {
    if (!attempt.render.ok) return "singbox render failed before credential-lock check; restarting singbox and retrying";
    return "credential-lock not settled yet; restarting singbox and retrying";
}

export function credentialLockSettleRecoveryHint(result: CredentialLockSettleResult): string {
    const blocks: string[] = [];
    for (const attempt of result.attempts) {
        if (credentialAttemptOk(attempt)) continue;
        const label = attempt.phase === "initial"
            ? "First credential-lock attempt before auto-restart"
            : "Final credential-lock attempt after retry";
        const detail = formatCredentialAttempt(attempt);
        if (detail) blocks.push(`${label}:\n${detail}`);
    }
    if (result.restart && !result.restart.ok) {
        blocks.push(`singbox restart failed:\n${formatShResult(result.restart)}`);
    }
    if (result.singboxReady && !result.singboxReady.ok) {
        blocks.push(`singbox did not become ready after restart: ${result.singboxReady.unready || "unknown"}`);
    }

    const prefix = blocks.length > 0 ? `${blocks.join("\n\n")}\n\n` : "";
    return `${prefix}Run:
  docker compose ps
  docker compose exec -T panel php artisan singbox:render --no-interaction
  docker compose exec -T panel php artisan credential-lock:check
  docker compose logs --tail=120 --no-color singbox panel caddy
  ${readSingboxConfigCommand().join(" ")}`;
}

export function deploymentSettleRecoveryHint(result: DeploymentSettleResult): string {
    if (!result.services.ok) {
        return `Containers did not become healthy: ${result.services.unready || "unknown"}

Run:
  docker compose ps
  docker compose logs --tail=120 --no-color caddy singbox panel db redis`;
    }

    if (result.credentialLock && !result.credentialLock.ok) {
        return credentialLockSettleRecoveryHint(result.credentialLock);
    }

    return "Post-deploy settle gate failed without a recorded failing stage. Run: docker compose ps";
}

function formatCredentialAttempt(attempt: CredentialLockAttempt): string {
    const parts: string[] = [];
    if (!attempt.render.ok) {
        parts.push(`singbox render failed:\n${formatShResult(attempt.render)}`);
    }
    if (attempt.guard && !attempt.guard.ok) {
        parts.push(`credential-lock check failed:\n${formatShResult(attempt.guard)}`);
    }
    return parts.join("\n");
}

function formatShResult(result: ShResult): string {
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    return output ? redactSensitive(output) : `exit ${result.code}`;
}
