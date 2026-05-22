// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/update.test.ts — pure update-flow helpers.

import { test, expect } from "bun:test";
import { caddyReloadCommand, shouldRemoveStaleCaddy } from "../update";
import {
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
