// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/doctor.test.ts

import { expect, test } from "bun:test";
import {
    checkDirectDialOutbound,
    checkRecentRealityInvalidOutput,
    checkSupervisordStatusOutput,
    indexComposeRowsByService,
    opensslSClientArgs,
    recentRealityLogArgs,
    summarizeCredentialLockOutput,
} from "../src/tasks/doctor";

test("indexComposeRowsByService indexes valid compose rows by service", () => {
    const rows = [
        JSON.stringify({ Service: "caddy", State: "running", Health: "healthy" }),
        "not json",
        JSON.stringify({ Service: "panel", State: "running" }),
        JSON.stringify({ Name: "missing-service", State: "running" }),
        "",
    ].join("\n");

    const indexed = indexComposeRowsByService(rows);

    expect(indexed.size).toBe(2);
    expect(indexed.get("caddy")?.["Health"]).toBe("healthy");
    expect(indexed.get("panel")?.["State"]).toBe("running");
    expect(indexed.has("missing-service")).toBe(false);
});

test("indexComposeRowsByService keeps the first row for duplicate services", () => {
    const rows = [
        JSON.stringify({ Service: "singbox", State: "running" }),
        JSON.stringify({ Service: "singbox", State: "exited" }),
    ].join("\n");

    expect(indexComposeRowsByService(rows).get("singbox")?.["State"]).toBe("running");
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

test("checkSupervisordStatusOutput accepts any all-running program count", () => {
    const checked = checkSupervisordStatusOutput(
        [
            "frankenphp                       RUNNING   pid 101, uptime 0:01:00",
            "queue                            RUNNING   pid 102, uptime 0:01:00",
            "messenger                        RUNNING   pid 103, uptime 0:01:00",
        ].join("\n"),
    );

    expect(checked.severity).toBe("pass");
    expect(checked.detail).toBe("3/3 programs running");
});

test("checkSupervisordStatusOutput warns on partial running state", () => {
    const checked = checkSupervisordStatusOutput(
        [
            "frankenphp                       RUNNING   pid 101, uptime 0:01:00",
            "queue                            FATAL     Exited too quickly",
        ].join("\n"),
    );

    expect(checked.severity).toBe("warn");
    expect(checked.detail).toBe("1/2 programs running");
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

test("summarizeCredentialLockOutput preserves drift reason", () => {
    expect(summarizeCredentialLockOutput(
        "credential-lock drift: db<->rendered extra_in_rendered=1\nmore details",
        "",
    )).toBe("credential-lock drift: db<->rendered extra_in_rendered=1");
});

test("summarizeCredentialLockOutput handles empty guard output", () => {
    expect(summarizeCredentialLockOutput("", "")).toContain("php artisan credential-lock:check");
});

test("summarizeCredentialLockOutput redacts secret-bearing guard output", () => {
    const summary = summarizeCredentialLockOutput(
        "APP_KEY=base64:abcdefghijklmnop1234567890ABCDEFGHIJKLMNOP== https://panel.example.com/api/v1/subscription/abcDEF_123-xyz",
        "",
    );

    expect(summary).toContain("APP_KEY=<redacted>");
    expect(summary).toContain("/api/v1/subscription/<redacted>");
    expect(summary).not.toContain("abcDEF_123-xyz");
});

test("doctor credential-lock hint points at recover diagnose", async () => {
    const body = await Bun.file("./src/tasks/doctor.ts").text();

    expect(body).toContain("ct recover diagnose");
    expect(body).toContain("php artisan credential-lock:check");
});

test("doctor checks APP_KEY and APP_PREVIOUS_KEYS without printing key material", async () => {
    const body = await Bun.file("./src/tasks/doctor.ts").text();

    expect(body).toContain("checkLaravelEncryptionKeys");
    expect(body).toContain("describeLaravelKey");
    expect(body).toContain("Fix or remove malformed APP_PREVIOUS_KEYS");
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
