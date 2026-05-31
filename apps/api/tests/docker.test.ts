// SPDX-License-Identifier: AGPL-3.0-only
// Pure mapping from Docker container State to dashboard service status.

import { expect, test } from "bun:test";
import { mapContainerState } from "../src/docker";
import { authorize } from "../src/docker-proxy";

test("running + healthy -> running", () => {
  const r = mapContainerState({ Status: "running", Health: { Status: "healthy" } });
  expect(r.status).toBe("running");
  expect(r.detail).toContain("healthy");
});

test("running without a healthcheck -> running", () => {
  expect(mapContainerState({ Status: "running" }).status).toBe("running");
});

test("running + unhealthy -> degraded", () => {
  expect(mapContainerState({ Status: "running", Health: { Status: "unhealthy" } }).status).toBe(
    "degraded",
  );
});

test("running + starting -> degraded", () => {
  expect(mapContainerState({ Status: "running", Health: { Status: "starting" } }).status).toBe(
    "degraded",
  );
});

test("restarting / paused -> degraded", () => {
  expect(mapContainerState({ Status: "restarting" }).status).toBe("degraded");
  expect(mapContainerState({ Status: "paused" }).status).toBe("degraded");
});

test("exited / dead -> stopped", () => {
  expect(mapContainerState({ Status: "exited" }).status).toBe("stopped");
  expect(mapContainerState({ Status: "dead" }).status).toBe("stopped");
});

test("missing container (null) -> stopped, not found", () => {
  const r = mapContainerState(null);
  expect(r.status).toBe("stopped");
  expect(r.detail).toContain("not found");
});

test("status values stay within the StatusSummary schema enum", () => {
  const allowed = new Set(["unknown", "running", "stopped", "degraded"]);
  for (const state of [
    { Status: "running", Health: { Status: "healthy" } },
    { Status: "running", Health: { Status: "unhealthy" } },
    { Status: "exited" },
    { Status: "paused" },
    null,
  ]) {
    expect(allowed.has(mapContainerState(state).status)).toBe(true);
  }
});

test("docker-proxy allowlist permits only health + restart for known containers", () => {
  expect(authorize("GET", "/containers/ct-caddy/json")).toBe(true);
  expect(authorize("GET", "/containers/ct-singbox/json")).toBe(true);
  expect(authorize("GET", "/containers/ct-admin-web/json")).toBe(true);
  expect(authorize("POST", "/containers/ct-singbox/restart")).toBe(true);
  expect(authorize("POST", "/containers/ct-caddy/restart")).toBe(true);
});

test("docker-proxy allowlist denies every escape vector", () => {
  // Wrong method for the path.
  expect(authorize("POST", "/containers/ct-caddy/json")).toBe(false);
  expect(authorize("GET", "/containers/ct-caddy/restart")).toBe(false);
  // Unknown / arbitrary container (admin-api must not inspect or restart itself here).
  expect(authorize("GET", "/containers/ct-admin-api/json")).toBe(false);
  expect(authorize("POST", "/containers/evil/restart")).toBe(false);
  // Host-root-granting / privileged Engine endpoints.
  expect(authorize("POST", "/containers/create")).toBe(false);
  expect(authorize("POST", "/containers/ct-caddy/exec")).toBe(false);
  expect(authorize("POST", "/containers/ct-caddy/start")).toBe(false);
  expect(authorize("POST", "/containers/ct-caddy/stop")).toBe(false);
  expect(authorize("GET", "/containers/json")).toBe(false); // list-all
  expect(authorize("GET", "/images/json")).toBe(false);
  expect(authorize("GET", "/info")).toBe(false);
  expect(authorize("POST", "/build")).toBe(false);
  // Path-traversal shapes never reach an allowed terminal.
  expect(authorize("GET", "/containers/../images/json")).toBe(false);
  expect(authorize("GET", "/containers/ct-caddy/json/../../images/json")).toBe(false);
});
