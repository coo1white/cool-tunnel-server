// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/doctor.test.ts

import { expect, test } from "bun:test";
import { checkDirectDialOutbound, checkSupervisordStatusOutput, indexComposeRowsByService } from "../src/tasks/doctor";

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
        domain_resolver: { server: "local-dns", strategy: "prefer_ipv4" },
        connect_timeout: "2s",
        fallback_delay: "100ms",
    });

    expect(checked.ok).toBe(true);
    expect(checked.detail).toContain("domain_resolver.strategy=prefer_ipv4");
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
