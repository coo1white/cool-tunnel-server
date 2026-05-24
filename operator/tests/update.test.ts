// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/update.test.ts — pure update-flow helpers.

import { test, expect } from "bun:test";
import { caddyReloadCommand, shouldRemoveStaleCaddy } from "../update";
import {
    credentialLockSettleRecoveryHint,
    deploymentSettleRecoveryHint,
    describeUnreadyServices,
    parseComposePsRows,
    serviceReady,
} from "../src/util/deploy-settle";

test("shouldRemoveStaleCaddy removes compose-created dead states", () => {
    expect(shouldRemoveStaleCaddy("created")).toBe(true);
    expect(shouldRemoveStaleCaddy("exited")).toBe(true);
    expect(shouldRemoveStaleCaddy("dead")).toBe(true);
});

test("shouldRemoveStaleCaddy preserves live or absent containers", () => {
    expect(shouldRemoveStaleCaddy("running")).toBe(false);
    expect(shouldRemoveStaleCaddy("restarting")).toBe(false);
    expect(shouldRemoveStaleCaddy("paused")).toBe(false);
    expect(shouldRemoveStaleCaddy("")).toBe(false);
});

test("caddyReloadCommand reloads from host-side docker compose, not panel ct-server-core", () => {
    expect(caddyReloadCommand()).toEqual([
        "docker",
        "compose",
        "exec",
        "-T",
        "caddy",
        "caddy",
        "reload",
        "--config",
        "/etc/caddy/Caddyfile",
        "--adapter",
        "caddyfile",
    ]);
});

test("deploy settle treats running/starting healthchecks as not ready", () => {
    const rows = parseComposePsRows([
        JSON.stringify({ Service: "panel", State: "running", Health: "healthy" }),
        JSON.stringify({ Service: "caddy", State: "running", Health: "starting" }),
        JSON.stringify({ Service: "singbox", State: "running", Health: "starting" }),
    ].join("\n"));

    expect(serviceReady(rows.get("panel"))).toBe(true);
    expect(serviceReady(rows.get("caddy"))).toBe(false);
    expect(serviceReady(rows.get("singbox"))).toBe(false);
    expect(describeUnreadyServices(rows, ["panel", "caddy", "singbox"])).toBe(
        "caddy=running/starting,singbox=running/starting",
    );
});

test("credential-lock settle recovery hint preserves first and final failures", () => {
    const hint = credentialLockSettleRecoveryHint({
        ok: false,
        attempts: [
            {
                phase: "initial",
                render: { ok: true, code: 0, stdout: "", stderr: "" },
                guard: {
                    ok: false,
                    code: 1,
                    stdout: "credential-lock drift: first failure",
                    stderr: "",
                },
            },
            {
                phase: "after-singbox-restart",
                render: { ok: true, code: 0, stdout: "", stderr: "" },
                guard: {
                    ok: false,
                    code: 1,
                    stdout: "credential-lock drift: final failure",
                    stderr: "",
                },
            },
        ],
    });

    expect(hint).toContain("First credential-lock attempt before auto-restart");
    expect(hint).toContain("credential-lock drift: first failure");
    expect(hint).toContain("Final credential-lock attempt after retry");
    expect(hint).toContain("credential-lock drift: final failure");
    expect(hint).toContain("docker compose logs --tail=120 --no-color singbox panel caddy");
});

test("credential-lock settle recovery hint records render failures before guard", () => {
    const hint = credentialLockSettleRecoveryHint({
        ok: false,
        attempts: [
            {
                phase: "initial",
                render: { ok: false, code: 1, stdout: "", stderr: "render exploded" },
            },
        ],
        restart: { ok: false, code: 1, stdout: "", stderr: "restart refused" },
    });

    expect(hint).toContain("singbox render failed");
    expect(hint).toContain("render exploded");
    expect(hint).toContain("singbox restart failed");
    expect(hint).toContain("restart refused");
});

test("credential-lock settle recovery hint redacts secret-bearing command output", () => {
    const hint = credentialLockSettleRecoveryHint({
        ok: false,
        attempts: [
            {
                phase: "initial",
                render: { ok: true, code: 0, stdout: "", stderr: "" },
                guard: {
                    ok: false,
                    code: 1,
                    stdout: "APP_KEY=base64:abcdefghijklmnop1234567890ABCDEFGHIJKLMNOP== https://panel.example.com/api/v1/subscription/abcDEF_123-xyz",
                    stderr: '{"uuid":"11111111-2222-4333-8444-555555555555"}',
                },
            },
        ],
    });

    expect(hint).toContain("APP_KEY=<redacted>");
    expect(hint).toContain("/api/v1/subscription/<redacted>");
    expect(hint).toContain('"uuid":"<redacted>"');
    expect(hint).not.toContain("abcDEF_123-xyz");
    expect(hint).not.toContain("11111111-2222-4333-8444-555555555555");
});

test("deployment settle recovery hint reports container readiness before credential guard", () => {
    const hint = deploymentSettleRecoveryHint({
        ok: false,
        services: {
            ok: false,
            services: ["panel", "singbox"],
            rows: null,
            unready: "singbox=running/starting",
        },
    });

    expect(hint).toContain("Containers did not become healthy: singbox=running/starting");
    expect(hint).toContain("docker compose logs --tail=120 --no-color");
});
