"use client";

import "./globals.css";

/** Last-resort error page if the root layout itself fails. */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="page page-narrow stack">
          <h1>Something went wrong</h1>
          <p>The error has been logged.</p>
          <div><button type="button" className="btn" onClick={reset}>Try again</button></div>
        </main>
      </body>
    </html>
  );
}
