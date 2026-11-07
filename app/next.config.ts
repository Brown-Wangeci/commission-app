import type { NextConfig } from "next";
import { loadMpesaEnv } from "./scripts/mpesa-env";

// app/.env is loaded by Next.js itself; the M-Pesa credentials are in the root .env.
loadMpesaEnv(__dirname);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["@prisma/client", "bcryptjs"],
  // A callback URL carries its signature, so it must not reach the request log.
  logging: { incomingRequests: { ignore: [/\/api\/payments\/callback\//] } },
};

export default nextConfig;
