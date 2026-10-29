import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { acceptAssignment, assignJob } from "@/lib/escrow/holds";
import { submitActivation } from "@/lib/activations/submit";
import { createJob, jobInputSchema } from "@/lib/jobs/jobs";
import { fundEscrow } from "@/lib/escrow/client";
import { resetDatabase } from "./helpers/db";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { createAgent, createClient, createUser } from "./helpers/factories";
import { daysFromNow, jobInput, publishFundedJob, submissionFor } from "./helpers/submission";

/** FR-04, issue #51: a job has a deadline, and after it takes no new work. */
let fake: FakeScoring;
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  fake = await startFakeScoring(replyWith("review", 0.4));
  process.env.SCORING_SERVICE_URL = fake.url;
});
afterAll(() => fake.close());
beforeEach(resetDatabase);

describe("job deadline (FR-04, issue #51)", () => {
  it("is required when posting, and stored as the end of that day in Kenya", async () => {
    const { deadline: _omitted, ...withoutDeadline } = jobInput();
    expect(jobInputSchema.safeParse(withoutDeadline).success).toBe(false);
    const { job } = await publishFundedJob({ deadline: "2027-03-31" });
    expect(job.deadlineAt?.toISOString()).toBe("2027-03-31T20:59:59.999Z");
  });

  it("must be a real date, not before publication, within two years", async () => {
    const client = await createClient();
    await fundEscrow({ clientId: client.id, amountCents: 10_000_000, actorId: client.userId });
    for (const deadline of ["2026-02-30", daysFromNow(-1), daysFromNow(800)]) {
      await expect(createJob({ clientId: client.id, actorId: client.userId, job: jobInput({ deadline }) })).rejects.toMatchObject({ status: 422 });
    }
    expect(await prisma.job.count()).toBe(0);
  });

  it("refuses assignment, acceptance and submission after it", async () => {
    const { job } = await publishFundedJob({ deadline: daysFromNow(0), slots: 3 });
    const admin = await createUser("admin");
    const agent = await createAgent();
    const deadline = job.deadlineAt!;
    const before = new Date(deadline.getTime() - 4 * HOUR);
    const after = new Date(deadline.getTime() + HOUR);

    await expect(assignJob({ jobId: job.id, agentId: agent.id, assignedById: admin.id, at: after })).rejects.toThrow(/deadline has passed/);
    const late = await assignJob({ jobId: job.id, agentId: agent.id, assignedById: admin.id, at: before });
    await expect(acceptAssignment({ assignmentId: late.id, agentId: agent.id, at: after })).rejects.toThrow(/deadline has passed/);

    const onTime = await assignJob({ jobId: job.id, agentId: agent.id, assignedById: admin.id, at: before });
    await acceptAssignment({ assignmentId: onTime.id, agentId: agent.id, at: new Date(before.getTime() + HOUR) });
    const accepted = await prisma.assignment.findUniqueOrThrow({ where: { id: onTime.id } });
    await expect(submitActivation(submissionFor(accepted, { submittedAt: after }))).rejects.toMatchObject({ status: 409 });
    expect(await prisma.activation.count()).toBe(0);
  });

  it("cannot be changed once the job is published", async () => {
    const { job } = await publishFundedJob();
    await expect(prisma.job.update({ where: { id: job.id }, data: { deadlineAt: new Date("2030-01-01") } })).rejects.toThrow(/deadline cannot change/);
  });
});
