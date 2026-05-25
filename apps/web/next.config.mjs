import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiOrigin = process.env.CT_API_INTERNAL_ORIGIN ?? "http://127.0.0.1:9000";
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: repoRoot,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
      { source: "/api/v1/:path*", destination: `${apiOrigin}/api/v1/:path*` },
      { source: "/up", destination: `${apiOrigin}/up` }
    ];
  }
};

export default nextConfig;
