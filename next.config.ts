import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["postgres", "bcryptjs"],
  eslint: {
    // ESLint 10 runs via `pnpm lint` (Next 15's built-in build-time runner passes removed ESLint 8 options).
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
