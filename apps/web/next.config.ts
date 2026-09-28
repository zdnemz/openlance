import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "standalone",
  // The app lives at `apps/web/` but the workspace root holds the lockfile and
  // pnpm's store. Tracing from the monorepo root keeps the standalone bundle
  // rooted at the repo, so the server entry is
  // `.next/standalone/apps/web/server.js` and deps resolve.
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
