import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  /**
   * Playwright ships native browser binaries and resolves drivers at runtime,
   * so it must be required from node_modules at runtime rather than traced and
   * bundled into the server build (SAD §11).
   */
  serverExternalPackages: ["playwright", "playwright-core"],
};

export default nextConfig;
