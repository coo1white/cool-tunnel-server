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

export async function waitForServicesReady(opts: DeploySettleOptions = {}): Promise<boolean> {
    const services = opts.services ?? CORE_DEPLOY_SERVICES;
    return waitFor({
        label: `compose health (${services.join(",")})`,
        maxAttempts: opts.maxAttempts ?? 36,
        intervalMs: opts.intervalMs ?? 5000,
        probe: async () => {
            const rows = await composeRows();
            if (!rows) return false;
            const unready = describeUnreadyServices(rows, services);
            if (unready === "") return true;
            opts.log?.(`waiting for containers: ${unready}`);
            return false;
        },
        progressEveryMs: 15_000,
        onTimeout: () => undefined,
    });
}

export interface CredentialLockSettleResult {
    readonly ok: boolean;
    readonly guard: ShResult;
}

export async function settleCredentialLock(opts: DeploySettleOptions = {}): Promise<CredentialLockSettleResult> {
    await renderSingboxConfig();
    let guard = await credentialLockCheck();
    if (guard.ok) return { ok: true, guard };

    opts.log?.("credential-lock not settled yet; restarting singbox and retrying");
    await restartSingbox();
    await waitForServicesReady({
        ...opts,
        services: ["singbox"],
        maxAttempts: Math.min(opts.maxAttempts ?? 24, 24),
    });
    await renderSingboxConfig();
    guard = await credentialLockCheck();
    return { ok: guard.ok, guard };
}

export function credentialLockRecoveryHint(guard: ShResult): string {
    const detail = [guard.stdout.trim(), guard.stderr.trim()].filter(Boolean).join("\n");
    const prefix = detail ? `${detail}\n\n` : "";
    return `${prefix}Run:
  docker compose ps
  docker compose exec -T panel php artisan singbox:render --no-interaction
  docker compose restart singbox caddy panel
  docker compose exec -T panel php artisan credential-lock:check
  ${readSingboxConfigCommand().join(" ")}
  docker compose logs --tail=80 panel singbox caddy`;
}
