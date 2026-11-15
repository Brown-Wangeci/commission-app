import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HSTS_VALUE, httpsRedirects, securityHeaders } from "@/lib/http/https-policy";

/**
 * IR-09 as configured. The hosted behaviour itself (Vercel's redirect and the
 * headers on a live response) is captured as evidence against the deployed
 * URL; this checks the rules the app ships with.
 */
describe("HTTPS policy (IR-09)", () => {
  it("sends HSTS for two years on every path", () => {
    expect(HSTS_VALUE).toBe("max-age=63072000; includeSubDomains");
    expect(securityHeaders()).toEqual([{ source: "/:path*", headers: [{ key: "Strict-Transport-Security", value: HSTS_VALUE }] }]);
  });

  it("redirects permanently to HTTPS only when a proxy says the request was plain HTTP", () => {
    const [rule] = httpsRedirects();
    expect(rule).toMatchObject({ source: "/:path*", destination: "https://:host/:path*", permanent: true });
    expect(rule.has).toContainEqual({ type: "header", key: "x-forwarded-proto", value: "http" });
  });

  it("next.config.ts uses both", () => {
    const text = fs.readFileSync(path.resolve(__dirname, "..", "next.config.ts"), "utf8");
    expect(text).toMatch(/headers\(\)\s*\{\s*return securityHeaders\(\);/);
    expect(text).toMatch(/redirects\(\)\s*\{\s*return httpsRedirects\(\);/);
  });
});
