import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { clientJob, clientJobs, createJob, jobInputSchema } from "@/lib/jobs/jobs";
import { resetDatabase } from "./helpers/db";
import { createClient } from "./helpers/factories";

beforeEach(resetDatabase);

/** As the post-job form sends it: text for the area, integer units for money. */
const valid = {
  title: "Wallet activations, Kibuye Market",
  description: "Sign up new wallet customers in person.",
  areaName: "Kibuye Market",
  areaLat: "-0.0995",
  areaLon: "34.768",
  areaRadiusM: "800",
  submissionValueCents: 250_000,
  commissionRateBps: 1200,
  flatCommissionCents: 5_000,
  slots: "20",
  initialDepositCents: 700_000,
  deadline: "2027-06-30",
};

describe("client jobs (issues #13, #41, #42)", () => {
  it("publishes a job with its commission structure, locking its maximum liability from the deposit", async () => {
    const client = await createClient();
    const job = await createJob({ clientId: client.id, actorId: client.userId, job: jobInputSchema.parse(valid) });
    // KSh 2,500.00 x 12.00% = KSh 300.00 + KSh 50.00 flat = KSh 350.00; 20 x KSh 350.00 = KSh 7,000.00.
    expect(job).toMatchObject({ areaRadiusM: 800, submissionValueCents: 250_000, commissionRateBps: 1200, flatCommissionCents: 5_000, slots: 20, escrowLockedCents: 700_000 });
    const view = await clientJobs(client.id);
    expect(view).toMatchObject({ depositedCents: 700_000, committedCents: 700_000, availableCents: 0 });
    expect(view.jobs[0].terms.commission).toMatchObject({ amountCents: 35_000, derivation: "KSh 2,500.00 × 12.00% = KSh 300.00 + KSh 50.00 flat" });
    expect(view.jobs[0].terms.liability.derivation).toBe("20 × KSh 350.00 per approved submission");
  });

  it("rejects an unusable job area, structure or amount", () => {
    expect(jobInputSchema.safeParse({ ...valid, areaRadiusM: "10" }).success).toBe(false);
    expect(jobInputSchema.safeParse({ ...valid, areaLat: "95" }).success).toBe(false);
    expect(jobInputSchema.safeParse({ ...valid, submissionValueCents: 12.5 }).success).toBe(false);
    expect(jobInputSchema.safeParse({ ...valid, submissionValueCents: "250000" }).success).toBe(false);
    expect(jobInputSchema.safeParse({ ...valid, submissionValueCents: 0 }).success).toBe(false);
    expect(jobInputSchema.safeParse({ ...valid, commissionRateBps: 0 }).success).toBe(false);
    expect(jobInputSchema.safeParse({ ...valid, commissionRateBps: 10_001 }).success).toBe(false);
    expect(jobInputSchema.safeParse({ ...valid, commissionRateBps: 12.5 }).success).toBe(false);
    expect(jobInputSchema.safeParse({ ...valid, flatCommissionCents: -1 }).success).toBe(false);
    // 1 cent at 1 basis point floors to nothing, and no flat amount: pays nothing.
    expect(jobInputSchema.safeParse({ ...valid, submissionValueCents: 1, commissionRateBps: 1, flatCommissionCents: 0 }).success).toBe(false);
    // 10,000 slots x KSh 3,500,000.00 does not fit in one record.
    expect(jobInputSchema.safeParse({ ...valid, submissionValueCents: 350_000_000, commissionRateBps: 10_000, slots: "10000" }).success).toBe(false);
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
