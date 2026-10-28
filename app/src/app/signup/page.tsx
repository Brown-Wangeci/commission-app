import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { homeFor } from "@/lib/auth/policy";
import { SignupForm } from "./SignupForm";

export default async function SignupPage() {
  const user = await currentUser();
  if (user) redirect(homeFor(user.role));
  return (
    <main className="auth-wrap">
      <div className="auth-card" style={{ maxWidth: 520 }}>
        <div className="mark">
          <span className="mark-glyph">L</span>
          <span>Ledgerfield</span>
        </div>
        <div className="card card-pad stack">
          <h1>Create an account</h1>
          <p className="muted small">
            Agents sign up customers and are paid per approved activation. Client businesses post jobs and
            fund them in escrow. Reviewer accounts are created by the platform, not here.
          </p>
          <SignupForm />
        </div>
      </div>
    </main>
  );
}
