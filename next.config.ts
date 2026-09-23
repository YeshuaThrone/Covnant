import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    workerThreads: false,
    cpus: 1,
  },
};

export default nextConfig;
