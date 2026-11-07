import { placeholderPng } from "../prisma/seed-support/placeholder-png";

/**
 * Drives the app through its own HTTP API, signed in as each role in turn.
 * Shared by scripts/rehearse-demo.ts and scripts/sandbox-run.ts.
 */
export const APP = process.env.APP_URL ?? "http://localhost:3000";
export const PASSWORD = "ledgerfield-demo";
export const DAY = 24 * 60 * 60 * 1000;

export type Session = { email: string; cookie: string };
export type Json = Record<string, unknown>;

function cookiesFrom(response: Response): string[] {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
}

export async function signIn(email: string): Promise<Session> {
  const csrf = await fetch(`${APP}/api/auth/csrf`);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const response = await fetch(`${APP}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: cookiesFrom(csrf).join("; ") },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD, json: "true" }),
  });
  const session = cookiesFrom(response).find((cookie) => cookie.includes("session-token="));
  if (!session) throw new Error(`Could not sign in as ${email} (HTTP ${response.status}).`);
  return { email, cookie: session };
}

export async function call<T = Json>(session: Session, method: string, path: string, body?: Json | FormData): Promise<T> {
  const isForm = body instanceof FormData;
  const response = await fetch(`${APP}${path}`, {
    method,
    headers: { cookie: session.cookie, ...(body && !isForm ? { "Content-Type": "application/json" } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} as ${session.email}: HTTP ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

export function nairobiDate(date: Date): string {
  return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Eight days of customer activity for the hold-close score. */
export function week(kind: "engaged" | "dormant_lapsed"): Json[] {
  return Array.from({ length: 8 }, (_, day) => {
    const active = kind === "engaged";
    return {
      day, customerActive: active, transactionCount: active ? 3 : 0, topupCents: active ? 10_000 : 0, usageMinutes: active ? 25 : 0,
      supportContact: false, complaintOrRefund: false, simActive: kind === "engaged" || day < 4,
    };
  });
}

/** The client's own evidence fields: the capture form is built from them. */
export const DEMO_EVIDENCE_FIELDS = [
  { label: "ID document seen", type: "single_select", mandatory: true, help: null, format: { options: ["National ID", "Passport", "Alien ID"].map((v) => ({ value: v, label: v })) } },
  { label: "Market stall number", type: "text", mandatory: true, help: null, format: { pattern: "code", minLength: 2, maxLength: 10 } },
  { label: "Photo of the stall", type: "photo", mandatory: true, help: null, format: { minCount: 1, maxCount: 4 } },
];

type FormField = { key: string; label: string; type: string };

/** Accepts an assignment and submits an activation against DEMO_EVIDENCE_FIELDS; it is scored at T0. */
export async function acceptAndSubmit(agent: Session, assignmentId: string, deviceId: string): Promise<{ activationId: string; reference: string; state: string }> {
  await call(agent, "POST", `/api/agent/assignments/${assignmentId}/accept`);
  // The form comes from the job's configuration; the submission names the version it was built from.
  const definition = await call<{ evidenceConfigId: string; version: number; jobFields: FormField[] }>(agent, "GET", `/api/agent/assignments/${assignmentId}/evidence-form`);
  const keyOf = (label: string) => definition.jobFields.find((f) => f.label === label)!.key;
  console.log(`   form built from evidence fields version ${definition.version}: ${definition.jobFields.map((f) => f.label).join("; ")}`);
  const form = new FormData();
  const context: Record<string, string> = {
    assignmentId, evidenceConfigId: definition.evidenceConfigId, gpsLat: "-0.0991", gpsLon: "34.7684", gpsAccuracyM: "9",
    deviceId, deviceOs: "android", appVersion: "web-0.1.0", networkType: "cellular", ipRegion: "region_c",
  };
  const values: Record<string, string> = {
    customerMsisdn: `07${String(Date.now()).slice(-8)}`, simRegisteredAt: nairobiDate(new Date(Date.now() - DAY)), activationMethod: "qr_scan",
    agentNote: "Customer registered at her stall; no proof screenshot, her phone battery was flat.",
    [keyOf("ID document seen")]: "National ID", [keyOf("Market stall number")]: "B-14",
  };
  for (const [key, value] of Object.entries(context)) form.set(key, value);
  for (const [key, value] of Object.entries(values)) form.set(`field:${key}`, value);
  const photoKey = keyOf("Photo of the stall");
  const meta = [];
  for (let i = 0; i < 3; i += 1) {
    form.append(`photos:${photoKey}`, new File([placeholderPng(900 + i)], `demo-${i + 1}.png`, { type: "image/png" }));
    meta.push({ capturedAt: new Date(Date.now() - (10 - i) * 60_000).toISOString(), gpsLat: -0.0992, gpsLon: 34.7683, gpsAccuracyM: 8, locationSource: "device" });
  }
  form.set(`photoMeta:${photoKey}`, JSON.stringify(meta));
  return call(agent, "POST", "/api/agent/activations", form);
}
