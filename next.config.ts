import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this repo. Without it Turbopack walks up and finds
  // the unrelated package-lock.json in the parent agency directory, and warns.
  turbopack: { root: __dirname },

  /**
   * Every storefront page reached by its `/order/...` path is on a platform host, and
   * a platform host is never indexed (`storefrontIndexable`): demos included, so a real
   * restaurant's menu never turns up in Google on a Serveside address.
   *
   * Here because an App Router page cannot set a response header, and these run on
   * the path as it arrived, before the proxy. A custom domain reaches the same pages
   * through `/`, `/checkout` and `/status/<id>` (rewritten in the proxy), so it does
   * not match this and its indexing is decided by the page's robots meta alone.
   */
  async headers() {
    return [{ source: "/order/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
};

export default nextConfig;
