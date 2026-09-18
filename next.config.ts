import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // 4GB sandbox: cap Turbopack so compiling the wagmi/viem client graph
  // GCs instead of ballooning into an OOM kill.
  experimental: {
    turbo: {
      memoryLimit: 2200,
    },
  },
};

export default nextConfig;
