import type { NextConfig } from "next";
import { loadRootEnv } from "./scripts/root-env";
import { httpsRedirects, securityHeaders } from "./src/lib/http/https-policy";

// app/.env is loaded by Next.js itself; the M-Pesa and Polygon credentials are in the root .env.
// On a hosted deployment there is no root .env; loadRootEnv then does nothing.
loadRootEnv(__dirname);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["@prisma/client", "bcryptjs"],
  // A callback URL carries its signature, so it must not reach the request log.
  logging: { incomingRequests: { ignore: [/\/api\/payments\/callback\//] } },
  // IR-09: HSTS on every response, and no plain-HTTP path (src/lib/http/https-policy.ts).
  async headers() {
    return securityHeaders();
  },
  async redirects() {
    return httpsRedirects();
  },
};

export default nextConfig;
