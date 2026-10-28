import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { homeFor } from "@/lib/auth/policy";
import { LoginForm } from "./LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await currentUser();
  if (user) redirect(homeFor(user.role));
  const { next } = await searchParams;
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="mark">
          <span className="mark-glyph">L</span>
          <span>Ledgerfield</span>
        </div>
        <div className="card card-pad stack">
          <h1>Sign in</h1>
          <p className="muted small">Agents, client businesses and reviewers all sign in here.</p>
          <LoginForm next={safeNext} />
        </div>
      </div>
    </main>
  );
}
