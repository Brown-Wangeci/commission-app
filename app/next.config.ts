import type { NextConfig } from "next";
import { loadRootEnv } from "./scripts/root-env";

// app/.env is loaded by Next.js itself; the M-Pesa and Polygon credentials are in the root .env.
loadRootEnv(__dirname);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["@prisma/client", "bcryptjs"],
  // A callback URL carries its signature, so it must not reach the request log.
  logging: { incomingRequests: { ignore: [/\/api\/payments\/callback\//] } },
};

export default nextConfig;
