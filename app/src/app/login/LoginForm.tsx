"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const result = await signIn("credentials", {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      redirect: false,
    });
    setBusy(false);
    if (!result || result.error) {
      setError("That email and password do not match an account.");
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {error && <div className="alert error" role="alert">{error}</div>}
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" className="input" autoComplete="email" required />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" className="input" autoComplete="current-password" required />
      </div>
      <button type="submit" className="btn primary block" disabled={busy}>
        {busy ? "Signing in" : "Sign in"}
      </button>
      <p className="small muted">
        New agent or client business? <Link href="/signup">Create an account</Link>
      </p>
    </form>
  );
}
