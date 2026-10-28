import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";
import { decideAccess, homeFor, isRole } from "@/lib/auth/policy";

/**
 * Role-based route protection for every page and API route under /admin,
 * /agent and /client. API routes get the standard JSON error; pages are
 * redirected. Route handlers check the role again (requireApiRole).
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
  const role = isRole(token?.role) ? token.role : null;
  const { pathname } = request.nextUrl;
  const decision = decideAccess(pathname, role);
  if (decision === "allow") return NextResponse.next();

  const isApi = pathname.startsWith("/api/");
  if (isApi) {
    const status = decision === "sign_in" ? 401 : 403;
    const code = decision === "sign_in" ? "unauthenticated" : "forbidden";
    const message = decision === "sign_in" ? "Sign in first." : "Your role cannot perform this action.";
    return NextResponse.json({ error: { code, message } }, { status });
  }
  const target = decision === "sign_in" || role === null ? "/login" : homeFor(role);
  const url = new URL(target, request.url);
  if (decision === "sign_in") url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/admin/:path*", "/agent/:path*", "/client/:path*", "/api/admin/:path*", "/api/agent/:path*", "/api/client/:path*"],
};
