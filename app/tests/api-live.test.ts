import { describe, expect, it } from "vitest";

/**
 * Issue #18, end to end: bad input to every API route returns a 4xx in the
 * standard error shape, never a 500 or a stack trace. Runs against a running
 * app with seed data (APP_URL, default http://localhost:3000) and is skipped
 * when none is running.
 */
const APP = process.env.APP_URL ?? "http://localhost:3000";
const MISSING = "00000000-0000-0000-0000-000000000000";

async function appIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${APP}/api/auth/csrf`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function signIn(email: string): Promise<string> {
  const csrf = await fetch(`${APP}/api/auth/csrf`);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const cookie = csrf.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const response = await fetch(`${APP}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ csrfToken, email, password: "ledgerfield-demo", json: "true" }),
  });
  const session = response.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.includes("session-token="));
  if (!session) throw new Error(`sign-in failed for ${email}`);
  return session;
}

type Case = { name: string; as: "none" | "agent" | "admin" | "client"; method: string; path: string; body?: string; type?: string; expect: number };

const CASES: Case[] = [
  { name: "anonymous admin route", as: "none", method: "GET", path: "/api/admin/review", expect: 401 },
  { name: "agent on admin route", as: "agent", method: "POST", path: `/api/admin/review/${MISSING}/approve`, body: "{}", expect: 403 },
  { name: "client on agent route", as: "client", method: "POST", path: "/api/agent/activations", expect: 403 },
  { name: "agent on client route", as: "agent", method: "POST", path: "/api/client/jobs", body: "{}", expect: 403 },
  { name: "signup malformed JSON", as: "none", method: "POST", path: "/api/auth/signup", body: "{oops", expect: 400 },
  { name: "signup invalid fields", as: "none", method: "POST", path: "/api/auth/signup", body: JSON.stringify({ role: "agent", email: "x" }), expect: 422 },
  { name: "signup as admin", as: "none", method: "POST", path: "/api/auth/signup", body: JSON.stringify({ role: "admin", name: "Mallory", email: "m@x.io", password: "longenough1" }), expect: 422 },
  { name: "queue with a bad tab", as: "admin", method: "GET", path: "/api/admin/review?tab=everything", expect: 422 },
  { name: "review detail for a missing activation", as: "admin", method: "GET", path: `/api/admin/review/${MISSING}`, expect: 404 },
  { name: "approve without a reason", as: "admin", method: "POST", path: `/api/admin/review/${MISSING}/approve`, body: JSON.stringify({ reason: "" }), expect: 422 },
  { name: "refuse a missing activation", as: "admin", method: "POST", path: `/api/admin/review/${MISSING}/refuse`, body: JSON.stringify({ reason: "not real" }), expect: 404 },
  { name: "ask for evidence with malformed JSON", as: "admin", method: "POST", path: `/api/admin/review/${MISSING}/request-evidence`, body: "[", expect: 400 },
  { name: "force T7 on a missing activation", as: "admin", method: "POST", path: `/api/admin/activations/${MISSING}/score-t7`, expect: 404 },
  { name: "assign without an agent", as: "admin", method: "POST", path: `/api/admin/jobs/${MISSING}/assign`, body: "{}", expect: 422 },
  { name: "assign to a missing job", as: "admin", method: "POST", path: `/api/admin/jobs/${MISSING}/assign`, body: JSON.stringify({ agentId: "nobody" }), expect: 404 },
  { name: "submit without multipart", as: "agent", method: "POST", path: "/api/agent/activations", body: "{}", type: "application/json", expect: 400 },
  { name: "submit with missing fields", as: "agent", method: "POST", path: "/api/agent/activations", body: "--b\r\nContent-Disposition: form-data; name=\"x\"\r\n\r\n1\r\n--b--\r\n", type: "multipart/form-data; boundary=b", expect: 422 },
  { name: "accept a missing assignment", as: "agent", method: "POST", path: `/api/agent/assignments/${MISSING}/accept`, expect: 404 },
  { name: "evidence reply without multipart", as: "agent", method: "POST", path: `/api/agent/activations/${MISSING}/evidence`, body: "{}", type: "application/json", expect: 400 },
  { name: "withdraw without a reason", as: "agent", method: "POST", path: `/api/agent/activations/${MISSING}/withdraw`, body: "{}", expect: 422 },
  { name: "contest a missing activation", as: "agent", method: "POST", path: `/api/agent/activations/${MISSING}/contest`, body: JSON.stringify({ note: "please look again" }), expect: 404 },
  { name: "post a job with no fields", as: "client", method: "POST", path: "/api/client/jobs", body: "{}", expect: 422 },
  { name: "fund with a negative amount", as: "client", method: "POST", path: `/api/client/jobs/${MISSING}/fund`, body: JSON.stringify({ amountKsh: -5 }), expect: 422 },
  { name: "fund a missing job", as: "client", method: "POST", path: `/api/client/jobs/${MISSING}/fund`, body: JSON.stringify({ amountKsh: 100 }), expect: 404 },
  { name: "report an empty week", as: "client", method: "POST", path: `/api/client/activations/${MISSING}/activity`, body: JSON.stringify({ days: [] }), expect: 422 },
  { name: "report a day out of range", as: "client", method: "POST", path: `/api/client/activations/${MISSING}/activity`, body: JSON.stringify({ days: [{ day: 9, customerActive: true, transactionCount: 1, topupAmountKsh: 1, usageMinutes: 1, supportContact: false, complaintOrRefund: false, simActive: true }] }), expect: 422 },
  { name: "mark no notifications", as: "agent", method: "POST", path: "/api/notifications/read", body: JSON.stringify({ ids: [] }), expect: 422 },
  { name: "evidence file that does not exist", as: "admin", method: "GET", path: `/api/evidence/${MISSING}`, expect: 404 },
  { name: "cron without a secret", as: "none", method: "POST", path: "/api/cron/scoring", expect: 401 },
  { name: "unknown API path", as: "none", method: "GET", path: "/api/does-not-exist", expect: 404 },
];

const up = await appIsUp();

describe.runIf(up)("every API route rejects bad input cleanly (issue #18)", async () => {
  const cookies = up
    ? { none: "", agent: await signIn("grace@ledgerfield.test"), admin: await signIn("reviewer@ledgerfield.test"), client: await signIn("client@ledgerfield.test") }
    : { none: "", agent: "", admin: "", client: "" };

  it.each(CASES)("$name -> $expect", async (testCase) => {
    const response = await fetch(`${APP}${testCase.path}`, {
      method: testCase.method,
      headers: {
        ...(testCase.as === "none" ? {} : { cookie: cookies[testCase.as] }),
        ...(testCase.body !== undefined ? { "Content-Type": testCase.type ?? "application/json" } : {}),
      },
      body: testCase.body,
    });
    const text = await response.text();
    expect(response.status, text).toBe(testCase.expect);
    const body = JSON.parse(text) as { error?: { code?: string; message?: string } };
    expect(typeof body.error?.code).toBe("string");
    expect(typeof body.error?.message).toBe("string");
    expect(text).not.toMatch(/\n\s+at |node_modules|PrismaClient/);
  });
});
