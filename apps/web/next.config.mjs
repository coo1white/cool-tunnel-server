import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// NOTE: rewrites() is evaluated at BUILD time and frozen into
// routes-manifest.json, so this reads CT_API_INTERNAL_ORIGIN as it
// exists during `next build` — NOT at runtime. The container image must
// therefore set it at build time (see docker/admin-web/Dockerfile); the
// 127.0.0.1:9000 fallback is for local `next dev` only.
const apiOrigin = process.env.CT_API_INTERNAL_ORIGIN ?? "http://127.0.0.1:9000";
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@cool-tunnel/shared"],
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
      { source: "/api/v1/:path*", destination: `${apiOrigin}/api/v1/:path*` },
      { source: "/up", destination: `${apiOrigin}/up` }
    ];
  }
};

export default nextConfig;
