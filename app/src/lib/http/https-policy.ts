/**
 * IR-09, HTTPS only, as next.config.ts applies it. Kept apart from
 * next.config.ts (and free of imports) so a test can check it without
 * loading the root .env.
 *
 * - HSTS tells browsers to use HTTPS for two years. A browser ignores the
 *   header on a plain-HTTP response (RFC 6797, section 8.1), so local
 *   development on http://localhost is unaffected.
 * - Vercel's edge already answers plain HTTP with a redirect before a
 *   request reaches the app. The redirect here is the same rule inside the
 *   app, for any proxy that forwards a plain-HTTP request with
 *   X-Forwarded-Proto: http. A request without that header (local
 *   `next dev`) is never redirected.
 */
export const HSTS_VALUE = "max-age=63072000; includeSubDomains";

export function securityHeaders() {
  return [{ source: "/:path*", headers: [{ key: "Strict-Transport-Security", value: HSTS_VALUE }] }];
}

export function httpsRedirects() {
  return [
    {
      source: "/:path*",
      has: [
        { type: "header" as const, key: "x-forwarded-proto", value: "http" },
        { type: "host" as const, value: "(?<host>.+)" },
      ],
      destination: "https://:host/:path*",
      permanent: true,
    },
  ];
}
