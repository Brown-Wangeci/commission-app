/**
 * Demonstrates FR-22 through the running app: signed in as the disputed
 * submission's client, its agent and an administrator, each retrieves the
 * audit record and verifies it against the chain, and an unrelated agent is
 * refused. Writes every response to the folder given.
 *
 * Prerequisites: the app running against a seeded, anchored database, with
 * the POLYGON_ read settings pointing at the chain the anchors are on.
 *
 * Usage: DATABASE_URL=<same database> npx tsx scripts/audit-demo.ts <dir>
 */
import fs from "node:fs";
import path from "node:path";
import { APP, call, signIn } from "./demo-client";
import { loadEnv } from "./load-env";

loadEnv();

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) throw new Error("Give the evidence folder as the first argument.");
  fs.mkdirSync(dir, { recursive: true });
  const { prisma } = await import("../src/lib/db");
  const activation = await prisma.activation.findFirstOrThrow({
    where: { state: "disputed" },
    include: { agent: { include: { user: true } }, job: { include: { client: { include: { user: true } } } } },
  });
  const outsider = await prisma.agent.findFirstOrThrow({ where: { id: { not: activation.agentId } }, include: { user: true } });
  const roles = [
    { role: "admin", email: "reviewer@ledgerfield.test" },
    { role: "agent", email: activation.agent.user.email },
    { role: "client", email: activation.job.client.user.email },
  ] as const;
  const results: Record<string, unknown> = { app: APP, activation: activation.reference, state: activation.state };
  for (const { role, email } of roles) {
    const session = await signIn(email);
    const base = `/api/${role}/activations/${activation.id}/audit`;
    const record = await call<{ events: unknown[] }>(session, "GET", base);
    const verification = await call<{ status: string; summary: string }>(session, "POST", `${base}/verify`);
    results[role] = { signedInAs: email, eventsRetrieved: record.events.length, record, verification };
    console.log(`${role} (${email}): ${record.events.length} events; ${verification.status}: ${verification.summary}`);
  }
  const intruder = await signIn(outsider.user.email);
  const refused = await fetch(`${APP}/api/agent/activations/${activation.id}/audit`, { headers: { cookie: intruder.cookie } });
  results.unrelatedAgent = { signedInAs: outsider.user.email, status: refused.status, body: await refused.json() };
  console.log(`unrelated agent (${outsider.user.email}): HTTP ${refused.status}`);
  const page = await fetch(`${APP}/admin/review/${activation.id}`, { headers: { cookie: (await signIn("reviewer@ledgerfield.test")).cookie } });
  const html = await page.text();
  results.disputeScreen = { status: page.status, showsAuditPanel: html.includes("Audit record"), showsVerifyButton: html.includes("Verify against the blockchain") };
  fs.writeFileSync(path.join(dir, "06-fr22-three-roles.json"), `${JSON.stringify(results, null, 2)}\n`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
