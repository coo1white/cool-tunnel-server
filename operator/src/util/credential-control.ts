// SPDX-License-Identifier: AGPL-3.0-only
// operator/src/util/credential-control.ts — canonical credential/sing-box
// control-plane commands.
//
// Keep the stable facts here:
//   - panel owns DB, subscription manifests, and singbox.json rendering
//   - /data/config/singbox.json is the rendered server config
//   - compose service name is "singbox" (container name is ct-singbox)
//
// Recipes and agents should call these helpers instead of carrying
// historical command strings in their own corners.

import { $, capture, type ShResult } from "./sh";

export const PANEL_SERVICE = "panel";
export const SINGBOX_SERVICE = "singbox";
export const SINGBOX_CONTAINER = "ct-singbox";
export const SINGBOX_CONFIG_PATH = "/data/config/singbox.json";

export function credentialLockCheck(): Promise<ShResult> {
    return capture($`${credentialLockCheckCommand()}`);
}

export function renderSingboxConfig(): Promise<ShResult> {
    return capture($`${renderSingboxConfigCommand()}`);
}

export function readSingboxConfig(): Promise<ShResult> {
    return capture($`${readSingboxConfigCommand()}`);
}

export function restartSingbox(): Promise<ShResult> {
    return capture($`${restartSingboxCommand()}`);
}

export function recreateSingbox(): Promise<ShResult> {
    return capture($`${recreateSingboxCommand()}`);
}

export function credentialLockCheckCommand(): string[] {
    return ["docker", "compose", "exec", "-T", PANEL_SERVICE, "bun", "run", "/opt/cool-tunnel/operator/src/index.ts", "admin", "doctor"];
}

export function renderSingboxConfigCommand(): string[] {
    return ["docker", "compose", "exec", "-T", PANEL_SERVICE, "bun", "run", "/opt/cool-tunnel/operator/src/index.ts", "admin", "render-singbox"];
}

export function readSingboxConfigCommand(): string[] {
    return ["docker", "compose", "exec", "-T", PANEL_SERVICE, "cat", SINGBOX_CONFIG_PATH];
}

export function restartSingboxCommand(): string[] {
    return ["docker", "compose", "restart", SINGBOX_SERVICE];
}

export function recreateSingboxCommand(): string[] {
    return ["docker", "compose", "up", "-d", SINGBOX_SERVICE];
}

export function singboxLogsCommand(tail = 30, noColor = false): string[] {
    return noColor
        ? ["docker", "compose", "logs", `--tail=${tail}`, "--no-color", SINGBOX_SERVICE]
        : ["docker", "compose", "logs", `--tail=${tail}`, SINGBOX_SERVICE];
}

export function singboxLogs(tail = 30, noColor = false): Promise<ShResult> {
    return capture($`${singboxLogsCommand(tail, noColor)}`);
}

export async function singboxRunning(): Promise<boolean> {
    const r = await capture($`docker compose ps --status running --services ${SINGBOX_SERVICE}`);
    return r.ok && r.stdout.split("\n").map((s) => s.trim()).includes(SINGBOX_SERVICE);
}

export async function singboxState(): Promise<string | null> {
    const r = await capture($`docker compose ps ${SINGBOX_SERVICE} --format json`);
    if (!r.ok) return null;
    for (const line of r.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const row = JSON.parse(trimmed) as { State?: unknown };
            return typeof row.State === "string" ? row.State : null;
        } catch {
            return null;
        }
    }
    return null;
}
