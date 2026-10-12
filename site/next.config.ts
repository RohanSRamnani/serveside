import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The engine's lockfile one directory up makes Turbopack infer the wrong
  // workspace root, which 404s every route. Pin it to this app.
  turbopack: { root: __dirname },
};

export default nextConfig;
