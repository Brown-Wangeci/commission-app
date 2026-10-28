import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { forbidden, unauthenticated } from "@/lib/http/errors";
import { authOptions } from "./options";
import { homeFor, type RoleName } from "./policy";

export type SessionUser = { id: string; name: string; email: string; role: RoleName };

export async function currentUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  const user = session?.user;
  if (!user?.id || !user.role) return null;
  return { id: user.id, name: user.name ?? "", email: user.email ?? "", role: user.role };
}

/** For pages: sends anonymous users to sign in and other roles to their own home. */
export async function requirePageRole(role: RoleName): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== role) redirect(homeFor(user.role));
  return user;
}

/** For route handlers: throws the standard 401 or 403 error. */
export async function requireApiRole(role: RoleName): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw unauthenticated();
  if (user.role !== role) throw forbidden();
  return user;
}
