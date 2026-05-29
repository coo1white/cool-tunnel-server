// SPDX-License-Identifier: AGPL-3.0-only
//
// Minimal, allowlist-only Docker Engine socket forwarder.
//
// admin-api no longer mounts the Docker socket directly. Instead this tiny
// service holds the socket (read-only mount) and exposes an HTTP endpoint that
// forwards ONLY two operations, and only for a fixed set of container names:
//
//   GET  /containers/<name>/json      -> dashboard container health
//   POST /containers/<name>/restart   -> the restart-services action
//
// Every other request — container create/exec, images, networks, volumes, the
// info/version endpoints, an unknown container name, or a wrong method — is
// refused with 403. So even a fully compromised admin-api cannot reach the
// Engine API surface that grants host root (e.g. POST /containers/create with a
// host bind mount + Privileged). The forwarder runs from the SAME image as
// admin-api, so it adds no new bundled image; its only attack surface is this
// file, which parses nothing but the request line.

const SOCKET = process.env["CT_DOCKER_SOCKET"] ?? "/var/run/docker.sock";
const PORT = Number(process.env["CT_DOCKER_PROXY_PORT"] ?? "2375");

// The only containers the dashboard inspects / the restart action targets.
const ALLOWED_CONTAINERS = new Set(["ct-caddy", "ct-singbox", "ct-admin-web"]);

// True only for an allowed (method, pathname) pair. Pure + exported for tests;
// deny-by-default. The container-name charset is restricted and then checked
// against the allowlist, so neither path traversal nor an arbitrary container
// can slip through.
export function authorize(method: string, pathname: string): boolean {
  const inspect = pathname.match(/^\/containers\/([A-Za-z0-9_.-]+)\/json$/);
  if (inspect && method === "GET") return ALLOWED_CONTAINERS.has(inspect[1] ?? "");
  const restart = pathname.match(/^\/containers\/([A-Za-z0-9_.-]+)\/restart$/);
  if (restart && method === "POST") return ALLOWED_CONTAINERS.has(restart[1] ?? "");
  return false;
}

function startProxy(): void {
  Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      if (!authorize(req.method, url.pathname)) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        // Forward only method + path + query to the socket — never the request
        // body or arbitrary headers. /json is a GET; /restart takes an optional
        // ?t=<seconds> and no body. This pins the forwarded call to exactly the
        // allowlisted shape.
        const upstream = await fetch(`http://localhost${url.pathname}${url.search}`, {
          method: req.method,
          signal: AbortSignal.timeout(15000),
          unix: SOCKET,
        } as RequestInit & { unix: string });
        return new Response(upstream.body, {
          status: upstream.status,
          headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
        });
      } catch {
        return new Response("docker upstream error", { status: 502 });
      }
    },
  });
  process.stdout.write(`[docker-proxy] listening on :${PORT}, socket ${SOCKET}\n`);
}

if (import.meta.main) startProxy();
