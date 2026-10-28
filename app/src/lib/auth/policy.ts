/**
 * Which role may reach which path. The single source for route protection:
 * middleware.ts applies it to every request and route handlers re-check it
 * with requireApiRole, so a missed middleware matcher cannot open a route.
 */
export type RoleName = "agent" | "admin" | "client";

export const ROLES: readonly RoleName[] = ["agent", "admin", "client"];

const PROTECTED_PREFIXES: ReadonlyArray<{ prefix: string; role: RoleName }> = [
  { prefix: "/admin", role: "admin" },
  { prefix: "/api/admin", role: "admin" },
  { prefix: "/agent", role: "agent" },
  { prefix: "/api/agent", role: "agent" },
  { prefix: "/client", role: "client" },
  { prefix: "/api/client", role: "client" },
];

/** The role a path requires, or null if any signed-in or anonymous user may reach it. */
export function requiredRole(pathname: string): RoleName | null {
  const match = PROTECTED_PREFIXES.find(
    ({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  return match?.role ?? null;
}

export type AccessDecision = "allow" | "sign_in" | "forbidden";

export function decideAccess(pathname: string, role: RoleName | null): AccessDecision {
  const needed = requiredRole(pathname);
  if (needed === null) return "allow";
  if (role === null) return "sign_in";
  return role === needed ? "allow" : "forbidden";
}

/** Where each role lands after signing in. */
export function homeFor(role: RoleName): string {
  if (role === "admin") return "/admin";
  if (role === "agent") return "/agent";
  return "/client";
}

export function isRole(value: unknown): value is RoleName {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
