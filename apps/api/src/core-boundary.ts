// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { AdminConfig } from "@cool-tunnel/config";
import type { AdminStore } from "@cool-tunnel/db";
import { redactSensitive, validateSafePath } from "@cool-tunnel/security";

export type CoreAction = "doctor" | "render-caddyfile" | "render-singbox" | "restart-services" | "backup" | "restore";

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
    value === "backup" ||
    value === "restore";
}

export async function runCoreAction(action: CoreAction, config: AdminConfig, store: AdminStore): Promise<BoundaryResult> {
  switch (action) {
    case "doctor":
      return { ok: true, code: 0, stdout: "Run `ct doctor` on the VPS shell for full host and Docker diagnostics.\n", stderr: "" };
    case "render-caddyfile":
      return renderCaddyfile(config, store);
    case "render-singbox":
      return renderSingbox(config, store);
    case "restart-services":
      return runCommand(["docker", "compose", "restart", "singbox", "caddy"]);
    case "backup":
      return { ok: false, code: 2, stdout: "", stderr: "Backup is intentionally CLI-only. Run `ct backup` from the VPS shell.\n" };
    case "restore":
      return { ok: false, code: 2, stdout: "", stderr: "Restore is intentionally CLI-only. Run `ct restore <backup.tar.gz>` from the VPS shell.\n" };
  }
}

export async function runCommand(argv: readonly string[], input?: string): Promise<BoundaryResult> {
  if (argv.length === 0 || argv.some((arg) => arg.includes("\0"))) throw new Error("invalid command argv");
  const stdin = input === undefined
    ? "ignore"
    : new Response(input).body ?? "ignore";
  const proc = Bun.spawn([...argv], {
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    ok: code === 0,
    code,
    stdout: redactSensitive(stdout),
    stderr: redactSensitive(stderr),
  };
}

async function renderSingbox(config: AdminConfig, store: AdminStore): Promise<BoundaryResult> {
  const output = validateSafePath(config.singboxConfigPath, "SINGBOX_CONFIG_PATH");
  mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
  const settings = store.getSettings();
  const activeAccounts = store.listProxyAccounts()
    .filter((account) => account.status === "active" && account.enabledProtocols.includes("vless_reality"))
    .map((account) => {
      const secret = store.getProxyAccount(account.id);
      return secret ? { username: account.username, uuid: secret.uuid } : null;
    })
    .filter((account): account is { username: string; uuid: string } => account !== null);
  const accounts = activeAccounts.length > 0
    ? activeAccounts
    : [{ username: "__no_active_accounts__", uuid: "00000000-0000-0000-0000-000000000000" }];
  const inputPath = `/tmp/ct-singbox-render-${crypto.randomUUID()}.json`;
  const input = {
    domain: settings.domain,
    listen_port: 443,
    reality_private_key: config.realityPrivateKey,
    reality_short_ids: settings.realityShortIds.length > 0 ? settings.realityShortIds : [""],
    reality_dest_host: settings.realityDestHost,
    reality_dest_port: 443,
    accounts,
    log_level: "info",
    direct_domain_strategy: "ipv4_only",
    direct_connect_timeout: "2s",
    direct_fallback_delay: "100ms",
  };
  try {
    writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600 });
    return await runCommand(["singbox-core", "render-server", "--input", inputPath, "--output", output, "--json"]);
  } finally {
    try {
      unlinkSync(inputPath);
    } catch {
      // best effort
    }
  }
}

async function renderCaddyfile(config: AdminConfig, store: AdminStore): Promise<BoundaryResult> {
  const settings = store.getSettings();
  const templatePath = validateSafePath(config.caddyfileTemplate, "CADDYFILE_TEMPLATE");
  const outputPath = validateSafePath(config.caddyfilePath, "CADDYFILE_PATH");
  const template = await Bun.file(templatePath).text();
  const body = renderTemplate(template, {
    Domain: settings.domain,
    PanelDomain: settings.panelDomain,
    AcmeEmail: settings.acmeEmail,
    AcmeDirectory: settings.acmeDirectory,
  });
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o755 });
  const previous = await Bun.file(outputPath).text().catch(() => null);
  const changed = previous !== body;
  if (changed) await Bun.write(outputPath, body);
  const hash = await sha256Hex(body);
  store.db.query("UPDATE server_config SET lastCaddyfileHash = ?, lastRenderedAt = ?, updatedAt = ? WHERE id = 1").run(hash, new Date().toISOString(), new Date().toISOString());
  return {
    ok: true,
    code: 0,
    stdout: JSON.stringify({ path: outputPath, bytes: body.length, hash, changed }) + "\n",
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
  if (value === "" || /[\r\n{}"]/.test(value)) throw new Error(`Caddyfile ${key} contains invalid characters`);
}

async function sha256Hex(body: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
