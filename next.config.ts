import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this repo. Without it Turbopack walks up and finds
  // the unrelated package-lock.json in the parent agency directory, and warns.
  turbopack: { root: __dirname },
};

export default nextConfig;
