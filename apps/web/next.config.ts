import type { NextConfig } from "next";
import path from "path";

/**
 * Where the API lives, for the build (lib/api-base.ts reads the result).
 *
 * `NEXT_PUBLIC_API_BASE` is inlined at build time, and lib/api-base.ts falls
 * back to `http://localhost:4000` when it is unset — right for `pnpm dev` and
 * self-hosting, fatal on Vercel, where an unset variable would bake localhost
 * into the browser bundle. On Vercel the API is a service of the same project
 * on the same domain (`/api/*` is rewritten to it), so the default there is the
 * empty string: same origin, relative `/api/...` URLs.
 *
 * Only a missing variable is defaulted, and only on Vercel. An explicit value —
 * including an explicit empty one — is left to Next's own inlining, and every
 * non-Vercel build (dev, CI, Caddy / standalone) is untouched.
 */
const sameOriginApiOnVercel: Pick<NextConfig, "env"> =
  process.env.VERCEL && process.env.NEXT_PUBLIC_API_BASE === undefined
    ? { env: { NEXT_PUBLIC_API_BASE: "" } }
    : {};

const nextConfig: NextConfig = {
  ...sameOriginApiOnVercel,
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
