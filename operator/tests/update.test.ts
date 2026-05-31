// SPDX-License-Identifier: AGPL-3.0-only
// operator/tests/update.test.ts — pure update-flow helpers.

import { expect, test } from "bun:test";
import { describeUnreadyServices, parseComposePsRows, serviceReady } from "../src/tasks/doctor";

test("deploy settle treats running/starting healthchecks as not ready", () => {
  const rows = parseComposePsRows(
    [
      JSON.stringify({ Service: "admin-api", State: "running", Health: "healthy" }),
      JSON.stringify({ Service: "caddy", State: "running", Health: "starting" }),
      JSON.stringify({ Service: "singbox", State: "running", Health: "starting" }),
    ].join("\n"),
  );

  expect(serviceReady(rows.get("admin-api"))).toBe(true);
  expect(serviceReady(rows.get("caddy"))).toBe(false);
  expect(serviceReady(rows.get("singbox"))).toBe(false);
  expect(describeUnreadyServices(rows, ["admin-api", "caddy", "singbox"])).toBe(
    "caddy=running/starting,singbox=running/starting",
  );
});
