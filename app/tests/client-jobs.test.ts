import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { clientJob, clientJobs, createJob, jobInputSchema } from "@/lib/jobs/jobs";
import { resetDatabase } from "./helpers/db";
import { createClient } from "./helpers/factories";

beforeEach(resetDatabase);

const valid = {
  title: "Wallet activations, Kibuye Market",
  description: "Sign up new wallet customers in person.",
  areaName: "Kibuye Market",
  areaLat: "-0.0995",
  areaLon: "34.768",
  areaRadiusM: "800",
  payoutPerActivationKsh: "350",
  commissionRatePercent: "10",
  slots: "20",
  initialFundingKsh: "3500",
};

describe("client jobs (issue #13)", () => {
  it("posts a job with its area and an initial escrow deposit", async () => {
    const client = await createClient();
    const job = await createJob({ clientId: client.id, actorId: client.userId, job: jobInputSchema.parse(valid) });
    expect(job).toMatchObject({ areaRadiusM: 800, payoutPerActivationKsh: 350, commissionRate: 0.1, slots: 20 });
    const [row] = await clientJobs(client.id);
    expect(row.balance).toMatchObject({ fundedKsh: 3500, availableKsh: 3500 });
  });

  it("rejects an unusable job area or payout", () => {
    expect(jobInputSchema.safeParse({ ...valid, areaRadiusM: "10" }).success).toBe(false);
    expect(jobInputSchema.safeParse({ ...valid, areaLat: "95" }).success).toBe(false);
    expect(jobInputSchema.safeParse({ ...valid, payoutPerActivationKsh: "12.5" }).success).toBe(false);
  });

  it("shows a job only to the client that posted it", async () => {
    const owner = await createClient();
    const other = await createClient();
    const job = await createJob({ clientId: owner.id, actorId: owner.userId, job: jobInputSchema.parse(valid) });
    await expect(clientJob(other.id, job.id)).rejects.toMatchObject({ status: 404 });
    expect((await clientJob(owner.id, job.id)).job.id).toBe(job.id);
    expect(await prisma.auditEvent.count({ where: { kind: "job_posted" } })).toBe(1);
  });
});
