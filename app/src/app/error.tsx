"use client";

import Link from "next/link";
import { useEffect } from "react";

/** Shown when a page fails unexpectedly. No internal detail reaches the screen. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="auth-wrap">
      <div className="auth-card card card-pad stack">
        <h1>Something went wrong</h1>
        <p className="small muted">The page could not be shown. The error has been logged{error.digest ? ` (reference ${error.digest})` : ""}.</p>
        <div className="row">
          <button type="button" className="btn primary" onClick={reset}>Try again</button>
          <Link className="btn" href="/">Go to my home page</Link>
        </div>
      </div>
    </main>
  );
}
