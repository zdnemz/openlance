import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // `standalone` is the self-hosted server bundle (see scripts/finalize-standalone.mjs).
  // Vercel builds and hosts its own output, so it is left off there.
  output: process.env.VERCEL ? undefined : "standalone",
  // The app lives at `apps/web/` but the workspace root holds the lockfile and
  // pnpm's store. Tracing from the monorepo root keeps the standalone bundle
  // rooted at the repo, so the server entry is
  // `.next/standalone/apps/web/server.js` and deps resolve.
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  reactStrictMode: false,
  // The signing and approval screens must not be frameable (clickjacking).
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
      ],
    }];
  },
};

export default nextConfig;
