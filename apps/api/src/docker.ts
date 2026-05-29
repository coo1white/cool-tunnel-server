// SPDX-License-Identifier: AGPL-3.0-only
// Live runtime-container health for the dashboard, read from the Docker
// Engine API over the mounted unix socket. Best-effort: any failure
// degrades a service to "unknown" rather than breaking /api/status.

import type { StatusSummary } from "@cool-tunnel/shared";

type ServiceEntry = StatusSummary["services"][number];
type ServiceStatus = ServiceEntry["status"]; // "unknown" | "running" | "stopped" | "degraded"

// Dashboard label -> compose container_name. admin-api reports itself as the
// "api" service from inside the process, so it is not queried here.
const RUNTIME_CONTAINERS: ReadonlyArray<{ name: string; container: string }> = [
    { name: "caddy", container: "ct-caddy" },
    { name: "singbox", container: "ct-singbox" },
    { name: "admin-web", container: "ct-admin-web" },
];

// admin-api no longer touches the Docker socket directly — it queries the
// allowlist-only docker-proxy over HTTP (see docker-proxy.ts). When unset
// (e.g. local dev without the proxy) every probe degrades to "unknown".
const DOCKER_API_BASE = (process.env["CT_DOCKER_API"] ?? "").replace(/\/+$/, "");
const QUERY_TIMEOUT_MS = 2000;

export interface DockerContainerState {
    readonly Status?: string; // running | exited | created | paused | dead | restarting
    readonly Health?: { readonly Status?: string }; // healthy | unhealthy | starting
}

// Pure mapping from a Docker container State to a dashboard service status.
// `null` means the container does not exist (never deployed / removed).
export function mapContainerState(state: DockerContainerState | null): { status: ServiceStatus; detail: string } {
    if (!state || !state.Status) return { status: "stopped", detail: "Container not found." };
    const health = state.Health?.Status;
    switch (state.Status) {
        case "running":
            if (health === "unhealthy") return { status: "degraded", detail: "Running but health check failing." };
            if (health === "starting") return { status: "degraded", detail: "Running; health check starting." };
            return { status: "running", detail: health === "healthy" ? "Running (healthy)." : "Running." };
        case "restarting":
            return { status: "degraded", detail: "Restarting." };
        case "paused":
            return { status: "degraded", detail: "Paused." };
        default:
            return { status: "stopped", detail: `Container ${state.Status}.` };
    }
}

// Returns the raw State, `null` for a 404 (no such container), or "error" when
// the socket can't be queried at all.
async function inspectContainer(container: string): Promise<DockerContainerState | null | "error"> {
    if (!DOCKER_API_BASE) return "error";
    try {
        const res = await fetch(`${DOCKER_API_BASE}/containers/${container}/json`, {
            signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        });
        if (res.status === 404) return null;
        if (!res.ok) return "error";
        const body = (await res.json()) as { State?: DockerContainerState };
        return body.State ?? null;
    } catch {
        return "error";
    }
}

// Live health for the runtime containers, suitable to append to the static
// service list from the DB layer. Never throws.
export async function containerServices(): Promise<ServiceEntry[]> {
    return Promise.all(
        RUNTIME_CONTAINERS.map(async ({ name, container }): Promise<ServiceEntry> => {
            const state = await inspectContainer(container);
            if (state === "error") {
                return { name, status: "unknown", detail: "Could not query Docker." };
            }
            const { status, detail } = mapContainerState(state);
            return { name, status, detail };
        }),
    );
}
