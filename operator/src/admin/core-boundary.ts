// SPDX-License-Identifier: AGPL-3.0-only
// Validated Bun/Rust/internal runtime boundary. No shell interpolation.

import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { AdminConfig } from "./config";
import { validateSafePath } from "./config";
import { AdminStorage } from "./storage";

export type CoreAction = "doctor" | "render-caddyfile" | "render-singbox" | "restart-services" | "update";

export interface BoundaryResult {
    readonly ok: boolean;
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

export function isCoreAction(value: unknown): value is CoreAction {
    return value === "doctor" ||
        value === "render-caddyfile" ||
        value === "render-singbox" ||
        value === "restart-services" ||
        value === "update";
}

export async function runCoreAction(action: CoreAction, config: AdminConfig): Promise<BoundaryResult> {
    switch (action) {
        case "doctor":
            return runCommand(["ct-server-core", "--version"]);
        case "render-caddyfile":
            return renderCaddyfile(config);
        case "render-singbox":
            return renderSingbox(config);
        case "restart-services":
            return runCommand(["docker", "compose", "restart", "singbox", "caddy"]);
        case "update":
            return runCommand(["./ct", "update"]);
    }
}

export async function runCommand(argv: readonly string[], input?: string): Promise<BoundaryResult> {
    if (argv.length === 0 || argv.some((arg) => arg.includes("\0"))) {
        throw new Error("invalid command argv");
    }
    const proc = Bun.spawn([...argv], {
        stdin: input === undefined ? "ignore" : "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });
    if (input !== undefined) {
        proc.stdin?.write(input);
        proc.stdin?.end();
    }
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { ok: code === 0, code, stdout, stderr };
}

async function renderSingbox(config: AdminConfig): Promise<BoundaryResult> {
    const output = validateSafePath(config.singboxConfigPath, "SINGBOX_CONFIG_PATH");
    mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
    const inputPath = `/tmp/ct-singbox-render-${crypto.randomUUID()}.json`;
    const input = {
        domain: config.domain,
        listen_port: 443,
        reality_private_key: config.realityPrivateKey,
        reality_short_ids: config.realityShortIds,
        reality_dest_host: config.realityDestHost,
        reality_dest_port: 443,
        accounts: [{ username: "__no_active_accounts__", uuid: "00000000-0000-0000-0000-000000000000" }],
        log_level: "info",
        direct_domain_strategy: "ipv4_only",
        direct_connect_timeout: "2s",
        direct_fallback_delay: "100ms",
    };
    try {
        writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600 });
        return await runCommand([
            "singbox-core",
            "render-server",
            "--input",
            inputPath,
            "--output",
            output,
            "--json",
        ]);
    } finally {
        try {
            unlinkSync(inputPath);
        } catch {
            // best effort
        }
    }
}

async function renderCaddyfile(config: AdminConfig): Promise<BoundaryResult> {
    const templatePath = validateSafePath(config.caddyfileTemplate, "CADDYFILE_TEMPLATE");
    const outputPath = validateSafePath(config.caddyfilePath, "CADDYFILE_PATH");
    const template = await Bun.file(templatePath).text();
    const body = renderTemplate(template, {
        Domain: config.domain,
        PanelDomain: config.panelDomain,
        AcmeEmail: config.acmeEmail,
        AcmeDirectory: config.acmeDirectory,
    });
    mkdirSync(dirname(outputPath), { recursive: true, mode: 0o755 });
    const previous = await Bun.file(outputPath).text().catch(() => null);
    const changed = previous !== body;
    if (changed) {
        await Bun.write(outputPath, body);
    }
    const hash = await sha256Hex(body);
    const storage = new AdminStorage(config.dbPath);
    try {
        storage.migrate();
        storage.createServerConfig({
            domain: config.domain,
            panelDomain: config.panelDomain,
            acmeEmail: config.acmeEmail,
            acmeDirectory: config.acmeDirectory,
            realityPrivateKey: config.realityPrivateKey,
            realityPublicKey: config.realityPublicKey,
            realityDestHost: config.realityDestHost,
            realityShortIds: config.realityShortIds,
        });
        storage.db.query(
            "UPDATE server_config SET lastCaddyfileHash = ?, lastRenderedAt = ?, updatedAt = ? WHERE id = 1",
        ).run(hash, new Date().toISOString(), new Date().toISOString());
    } finally {
        storage.close();
    }
    return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({ path: outputPath, bytes: body.length, hash, changed, active_users: 0 }) + "\n",
        stderr: "",
    };
}

function renderTemplate(template: string, bindings: Record<string, string>): string {
    let body = template;
    for (const [key, value] of Object.entries(bindings)) {
        caddyfileValidate(key, value);
        body = body.replaceAll(`{{ .${key} }}`, value);
    }
    return body;
}

function caddyfileValidate(key: string, value: string): void {
    if (value === "" || /[\r\n{}"]/.test(value)) {
        throw new Error(`Caddyfile ${key} contains invalid characters`);
    }
}

async function sha256Hex(body: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
