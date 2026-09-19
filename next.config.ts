import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Sandbox: cap Turbopack memory so compiling the viem client graph GCs
  // instead of ballooning into an OOM kill.
  experimental: {
    turbopackMemoryLimit: 2200,
  },
};

export default nextConfig;
