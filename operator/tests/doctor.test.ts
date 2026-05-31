// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/doctor.test.ts

import { expect, test } from "bun:test";
import {
    checkDirectDialOutbound,
    classifyMigrationStatus,
    checkRecentRealityInvalidOutput,
    describeUnreadyServices,
    indexComposeRowsByService,
    opensslSClientArgs,
    parseComposePsRows,
    recentRealityLogArgs,
} from "../src/tasks/doctor";

test("indexComposeRowsByService indexes valid compose rows by service", () => {
    const rows = [
        JSON.stringify({ Service: "caddy", State: "running", Health: "healthy" }),
        "not json",
        JSON.stringify({ Service: "admin-api", State: "running" }),
        JSON.stringify({ Name: "missing-service", State: "running" }),
        "",
    ].join("\n");

    const indexed = indexComposeRowsByService(rows);

    expect(indexed.size).toBe(2);
    expect(indexed.get("caddy")?.["Health"]).toBe("healthy");
    expect(indexed.get("admin-api")?.["State"]).toBe("running");
    expect(indexed.has("missing-service")).toBe(false);
});

test("indexComposeRowsByService keeps the first row for duplicate services", () => {
    const rows = [
        JSON.stringify({ Service: "singbox", State: "running" }),
        JSON.stringify({ Service: "singbox", State: "exited" }),
    ].join("\n");

    expect(indexComposeRowsByService(rows).get("singbox")?.["State"]).toBe("running");
});

test("parseComposePsRows reads a single JSON array (older compose output)", () => {
    const arrayOutput = JSON.stringify([
        { Service: "caddy", State: "running", Health: "healthy" },
        { Service: "admin-api", State: "running", Health: "" },
        { Service: "admin-web", State: "running", Health: "" },
        { Service: "singbox", State: "running", Health: "healthy" },
        // docker-proxy was added in v0.6.0 (allowlist-only Docker-socket
        // forwarder). It has no healthcheck, so Health is "" — the doctor
        // accepts running-without-healthcheck as healthy.
        { Service: "docker-proxy", State: "running", Health: "" },
    ]);
    const rows = parseComposePsRows(arrayOutput);
    expect(rows.size).toBe(5);
    expect(rows.get("caddy")?.health).toBe("healthy");
    // A healthy array-formatted stack must NOT be reported as unready.
    expect(describeUnreadyServices(rows, ["admin-api", "admin-web", "singbox", "caddy", "docker-proxy"])).toBe("");
});

test("parseComposePsRows still reads NDJSON output", () => {
    const ndjson = [
        JSON.stringify({ Service: "caddy", State: "running", Health: "healthy" }),
        JSON.stringify({ Service: "admin-api", State: "exited", Health: "" }),
    ].join("\n");
    const rows = parseComposePsRows(ndjson);
    expect(rows.size).toBe(2);
    expect(describeUnreadyServices(rows, ["admin-api"])).toBe("admin-api=exited");
});

test("checkDirectDialOutbound accepts current domain_resolver strategy shape", () => {
    const checked = checkDirectDialOutbound({
        type: "direct",
        tag: "direct",
        domain_resolver: { server: "local-dns", strategy: "ipv4_only" },
        connect_timeout: "2s",
        fallback_delay: "100ms",
    });

    expect(checked.ok).toBe(true);
    expect(checked.detail).toContain("domain_resolver.strategy=ipv4_only");
});

test("checkDirectDialOutbound still accepts legacy domain_strategy shape", () => {
    const checked = checkDirectDialOutbound({
        type: "direct",
        tag: "direct",
        domain_strategy: "ipv4_only",
        connect_timeout: "2s",
        fallback_delay: "100ms",
    });

    expect(checked.ok).toBe(true);
    expect(checked.detail).toContain("domain_strategy=ipv4_only");
});

test("checkDirectDialOutbound warns on missing strategy", () => {
    const checked = checkDirectDialOutbound({
        type: "direct",
        tag: "direct",
        connect_timeout: "2s",
        fallback_delay: "100ms",
    });

    expect(checked.ok).toBe(false);
    expect(checked.detail).toContain("no direct dial domain strategy");
});

test("checkRecentRealityInvalidOutput passes when recent logs are clean", () => {
    const checked = checkRecentRealityInvalidOutput("");

    expect(checked.severity).toBe("pass");
    expect(checked.detail).toContain("no invalid handshakes");
});

test("checkRecentRealityInvalidOutput ignores unrelated singbox logs", () => {
    const checked = checkRecentRealityInvalidOutput(
        [
            "ct-singbox | INFO inbound/vless[vless-in]: connection opened",
            "ct-singbox | ERROR unrelated TLS handshake failure",
        ].join("\n"),
    );

    expect(checked.severity).toBe("pass");
});

test("checkRecentRealityInvalidOutput warns with count only", () => {
    const checked = checkRecentRealityInvalidOutput(
        [
            "ct-singbox | +0000 2026-05-22 11:10:49 ERROR inbound/vless[vless-in]: TLS handshake: REALITY: processed invalid connection",
            "ct-singbox | +0000 2026-05-22 11:10:54 ERROR inbound/vless[vless-in]: TLS handshake: REALITY: processed invalid connection",
        ].join("\n"),
    );

    expect(checked.severity).toBe("warn");
    expect(checked.detail).toContain("2 invalid handshakes");
    expect(checked.detail).not.toContain("REALITY");
    expect(checked.detail).not.toContain("ct-singbox");
});

test("opensslSClientArgs keeps hostile domain inside one argv value", () => {
    const hostile = "panel.example.com; touch /tmp/ct-pwn #";
    expect(opensslSClientArgs(hostile)).toEqual([
        "s_client",
        "-servername",
        hostile,
        "-connect",
        `${hostile}:443`,
    ]);
});

test("recentRealityLogArgs avoids shell pipelines", () => {
    expect(recentRealityLogArgs()).toEqual(["compose", "logs", "--since=10m", "--no-color", "singbox"]);
});

test("classifyMigrationStatus reports current schema as pass", () => {
    const checked = classifyMigrationStatus(JSON.stringify({
        ok: true,
        currentVersion: 5,
        requiredVersion: 5,
        message: "SQLite schema is current.",
    }));

    expect(checked.severity).toBe("pass");
    expect(checked.detail).toContain("schema 5/5");
});

test("classifyMigrationStatus makes stale schema actionable", () => {
    const checked = classifyMigrationStatus(JSON.stringify({
        ok: false,
        currentVersion: 3,
        requiredVersion: 5,
        message: "Run `ct admin migrate` before starting the admin runtime.",
    }));

    expect(checked.severity).toBe("fail");
    expect(checked.hint).toContain("ct admin migrate");
});
