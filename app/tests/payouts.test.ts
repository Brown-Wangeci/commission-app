import type { PayoutAuthorisation, Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { approveActivation, refuseActivation } from "@/lib/review/actions";
import { runDueScoringJobs } from "@/lib/scoring/runner";
import { recordAuthorisation, usePayoutAuthoriser, type PayoutAuthoriser, type PayoutRequest } from "@/lib/payouts/boundary";
import { NoopPayoutAuthoriser } from "@/lib/payouts/noop";
import { addWeekOfActivity } from "./helpers/activity";
import { resetDatabase } from "./helpers/db";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { createUser } from "./helpers/factories";
import { submitReady } from "./helpers/submission";

let fake: FakeScoring;

beforeAll(async () => {
  fake = await startFakeScoring();
  process.env.SCORING_SERVICE_URL = fake.url;
});
afterAll(() => fake.close());
beforeEach(async () => {
  await resetDatabase();
  fake.setHandler(replyWith("reject", 0.9));
  usePayoutAuthoriser(new NoopPayoutAuthoriser());
});
afterEach(() => usePayoutAuthoriser(new NoopPayoutAuthoriser()));

/** A stand-in for a real settlement provider: records, and remembers what it was asked. */
class RecordingAuthoriser implements PayoutAuthoriser {
  readonly provider = "test-provider";
  readonly requests: PayoutRequest[] = [];
  async authorise(tx: Prisma.TransactionClient, request: PayoutRequest): Promise<PayoutAuthorisation> {
    this.requests.push(request);
    return recordAuthorisation(tx, request, this.provider, `ref-${this.requests.length}`);
  }
}

describe("payout authorisation boundary (issue #15)", () => {
  it("records a no-op authorisation when a reviewer approves, with the hold's amount and the agent's number", async () => {
    const reviewer = await createUser("admin");
    const { activationId } = await submitReady();
    await approveActivation({ activationId, reviewerId: reviewer.id, reason: "Evidence checks out" });
    const payout = await prisma.payoutAuthorisation.findUniqueOrThrow({ where: { activationId } });
    expect(payout).toMatchObject({ provider: "noop", amountCents: 30_000, payoutMsisdn: "0712000000", authorisedById: reviewer.id, providerRef: null });
  });

  it("records an automatic authorisation when the hold-close score releases", async () => {
    fake.setHandler(replyWith("review", 0.4));
    const { activationId } = await submitReady();
    await addWeekOfActivity(activationId);
    fake.setHandler(replyWith("auto_release", 0.02));
    await runDueScoringJobs(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    const payout = await prisma.payoutAuthorisation.findUniqueOrThrow({ where: { activationId } });
    expect(payout.authorisedById).toBeNull();
  });

  it("authorises nothing on a refusal", async () => {
    const reviewer = await createUser("admin");
    const { activationId } = await submitReady();
    await refuseActivation({ activationId, reviewerId: reviewer.id, reason: "Customer denies it" });
    expect(await prisma.payoutAuthorisation.count()).toBe(0);
  });

  it("lets a different implementation replace the no-op with no upstream change", async () => {
    const replacement = new RecordingAuthoriser();
    usePayoutAuthoriser(replacement);
    const reviewer = await createUser("admin");
    const { activationId } = await submitReady();
    await approveActivation({ activationId, reviewerId: reviewer.id, reason: "Evidence checks out" });
    expect(replacement.requests).toHaveLength(1);
    expect(replacement.requests[0]).toMatchObject({ activationId, amountCents: 30_000, authorisedById: reviewer.id });
    expect((await prisma.payoutAuthorisation.findUniqueOrThrow({ where: { activationId } })).provider).toBe("test-provider");
  });

  it("rolls the approval back if the authoriser fails", async () => {
    usePayoutAuthoriser({ provider: "broken", authorise: async () => { throw new Error("provider down"); } });
    const reviewer = await createUser("admin");
    const { activationId } = await submitReady();
    await expect(approveActivation({ activationId, reviewerId: reviewer.id, reason: "Evidence checks out" })).rejects.toThrow("provider down");
    expect((await prisma.activation.findUniqueOrThrow({ where: { id: activationId } })).state).toBe("in_review");
  });
});
