// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AdminConfig } from "@cool-tunnel/config";
import type { AdminStore } from "@cool-tunnel/db";
import { redactSensitive, validateSafePath } from "@cool-tunnel/security";

export type CoreAction =
  | "doctor"
  | "render-caddyfile"
  | "render-singbox"
  | "restart-services"
  | "backup"
  | "restore";

export interface BoundaryResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function isCoreAction(value: unknown): value is CoreAction {
  return (
    value === "doctor" ||
    value === "render-caddyfile" ||
    value === "render-singbox" ||
    value === "restart-services" ||
    value === "backup" ||
    value === "restore"
  );
}

export async function runCoreAction(
  action: CoreAction,
  config: AdminConfig,
  store: AdminStore,
): Promise<BoundaryResult> {
  switch (action) {
    case "doctor":
      return {
        ok: true,
        code: 0,
        stdout: "Run `ct doctor` on the VPS shell for full host and Docker diagnostics.\n",
        stderr: "",
      };
    case "render-caddyfile":
      return renderCaddyfile(config, store);
    case "render-singbox":
      return renderSingbox(config, store);
    case "restart-services":
      return restartServices();
    case "backup":
      return {
        ok: false,
        code: 2,
        stdout: "",
        stderr: "Backup is intentionally CLI-only. Run `ct backup` from the VPS shell.\n",
      };
    case "restore":
      return {
        ok: false,
        code: 2,
        stdout: "",
        stderr:
          "Restore is intentionally CLI-only. Run `ct restore <backup.tar.gz>` from the VPS shell.\n",
      };
  }
}

// Restart the data-plane containers via the allowlist-only docker-proxy
// (POST /containers/<name>/restart), not the Docker socket / `docker compose`
// CLI (which isn't installed in the admin-api image). The proxy permits only
// this restart + the health read, so the admin-api never holds socket access
// that could create a privileged container.
async function restartServices(): Promise<BoundaryResult> {
  const base = (process.env.CT_DOCKER_API ?? "").replace(/\/+$/, "");
  if (!base) {
    return {
      ok: false,
      code: 2,
      stdout: "",
      stderr:
        "Restart is unavailable: CT_DOCKER_API (the Docker proxy) is not configured. Run `ct restart` from the VPS shell.\n",
    };
  }
  const done: string[] = [];
  for (const name of ["ct-singbox", "ct-caddy"]) {
    try {
      const res = await fetch(`${base}/containers/${name}/restart`, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        return {
          ok: false,
          code: 1,
          stdout: done.join("\n"),
          stderr: `Failed to restart ${name}: HTTP ${res.status}.\n`,
        };
      }
      done.push(`Restarted ${name}.`);
    } catch (error) {
      return {
        ok: false,
        code: 1,
        stdout: done.join("\n"),
        stderr: redactSensitive(
          `Error restarting ${name}: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      };
    }
  }
  return { ok: true, code: 0, stdout: `${done.join("\n")}\n`, stderr: "" };
}

export async function runCommand(argv: readonly string[], input?: string): Promise<BoundaryResult> {
  if (argv.length === 0 || argv.some((arg) => arg.includes("\0")))
    throw new Error("invalid command argv");
  const stdin = input === undefined ? "ignore" : (new Response(input).body ?? "ignore");
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

export interface RenderAccount {
  readonly username: string;
  readonly uuid: string;
}

// Build the VLESS user list for the sing-box server config from the DB.
//
// Each active vless_reality account contributes its current UUID. While a
// rotation's grace window is still open (previousUuidValidUntil in the
// future), the pre-rotation UUID is emitted too — as a second user named
// `<username>-prev` — so `regenerate-uuid` doesn't instantly reject clients
// that haven't re-fetched their subscription yet. The window matches the one
// `AdminStore.regenerateProxyUuid` records (10 min); after it lapses the old
// UUID drops out on the next render.
//
// Falls back to a single inert placeholder user when there are no active
// accounts, because sing-box rejects an empty `users[]`.
export function buildServerRenderAccounts(
  store: AdminStore,
  now: number = Date.now(),
): RenderAccount[] {
  const accounts: RenderAccount[] = [];
  for (const account of store.listProxyAccounts()) {
    if (account.status !== "active" || !account.enabledProtocols.includes("vless_reality"))
      continue;
    const secret = store.getProxyAccount(account.id);
    if (!secret?.uuid) continue;
    accounts.push({ username: account.username, uuid: secret.uuid });
    const graceUntil = account.previousUuidValidUntil;
    if (
      secret.previousUuid &&
      secret.previousUuid !== secret.uuid &&
      graceUntil !== null &&
      Date.parse(graceUntil) > now
    ) {
      accounts.push({ username: `${account.username}-prev`, uuid: secret.previousUuid });
    }
  }
  if (accounts.length === 0) {
    return [{ username: "__no_active_accounts__", uuid: "00000000-0000-0000-0000-000000000000" }];
  }
  return accounts;
}

async function renderSingbox(config: AdminConfig, store: AdminStore): Promise<BoundaryResult> {
  const output = validateSafePath(config.singboxConfigPath, "SINGBOX_CONFIG_PATH");
  mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
  const settings = store.getSettings();
  const accounts = buildServerRenderAccounts(store);
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

async function renderCaddyfile(config: AdminConfig, store: AdminStore): Promise<BoundaryResult> {
  const settings = store.getSettings();
  const templatePath = validateSafePath(config.caddyfileTemplate, "CADDYFILE_TEMPLATE");
  const outputPath = validateSafePath(config.caddyfilePath, "CADDYFILE_PATH");
  const template = await Bun.file(templatePath).text();
  const body = renderTemplate(
    template,
    {
      Domain: settings.domain,
      PanelDomain: settings.panelDomain,
      AcmeEmail: settings.acmeEmail,
      AcmeDirectory: settings.acmeDirectory,
    },
    { LandingPage: config.landingPageEnabled },
  );
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o755 });
  const previous = await Bun.file(outputPath)
    .text()
    .catch(() => null);
  const changed = previous !== body;
  if (changed) await Bun.write(outputPath, body);
  const hash = await sha256Hex(body);
  store.db
    .query(
      "UPDATE server_config SET lastCaddyfileHash = ?, lastRenderedAt = ?, updatedAt = ? WHERE id = 1",
    )
    .run(hash, new Date().toISOString(), new Date().toISOString());
  return {
    ok: true,
    code: 0,
    stdout: `${JSON.stringify({ path: outputPath, bytes: body.length, hash, changed })}\n`,
    stderr: "",
  };
}

export function renderTemplate(
  template: string,
  bindings: Record<string, string>,
  flags: Record<string, boolean> = {},
): string {
  let body = template;
  // Resolve `{{ if .Flag }} … {{ end }}` blocks first, so string
  // substitution never runs on an excluded branch (e.g. {{ .Domain }}
  // inside a disabled landing-page block).
  for (const [key, on] of Object.entries(flags)) {
    body = applyConditional(body, key, on);
  }
  for (const [key, value] of Object.entries(bindings)) {
    caddyfileValidate(key, value);
    body = body.replaceAll(`{{ .${key} }}`, value);
  }
  return body;
}

// Minimal block conditional: the `{{ if .Flag }}` and `{{ end }}` markers each
// sit on their own line. Removing the marker lines (and, when off, everything
// between them) leaves no stray blank lines. No nesting and no else-branch —
// that is all the Caddyfile template needs.
function applyConditional(body: string, key: string, on: boolean): string {
  const block = new RegExp(`\\{\\{ if \\.${key} \\}\\}\\n([\\s\\S]*?)\\{\\{ end \\}\\}\\n`, "g");
  return body.replace(block, on ? "$1" : "");
}

function caddyfileValidate(key: string, value: string): void {
  if (value === "" || /[\r\n{}"]/.test(value))
    throw new Error(`Caddyfile ${key} contains invalid characters`);
}

async function sha256Hex(body: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
