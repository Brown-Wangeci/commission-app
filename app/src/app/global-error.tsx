"use client";

/** Last-resort error page if the root layout itself fails. */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 32, background: "#f4f3ee", color: "#1b1c19" }}>
        <h1 style={{ fontSize: 22 }}>Something went wrong</h1>
        <p>The error has been logged.</p>
        <button type="button" onClick={reset}>Try again</button>
      </body>
    </html>
  );
}
