import Link from "next/link";

export default function NotFound() {
  return (
    <main className="auth-wrap">
      <div className="auth-card card card-pad stack">
        <h1>Not found</h1>
        <p className="small muted">That page does not exist, or you do not have access to it.</p>
        <Link className="btn" href="/">Go to my home page</Link>
      </div>
    </main>
  );
}
