// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/doctor.test.ts

import { expect, test } from "bun:test";
import { indexComposeRowsByService } from "../src/tasks/doctor";

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
