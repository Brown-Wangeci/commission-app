import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { scoreResponseSchema } from "@/lib/scoring/contract";
import { decisionsFor, latestDecision, recordDecision } from "@/lib/scoring/decisions";
import { resetDatabase } from "./helpers/db";
import { createActivation, createScenario } from "./helpers/factories";
import { fakeResponse } from "./helpers/responses";

beforeEach(resetDatabase);

async function newActivationId(): Promise<string> {
  const { assignment } = await createScenario();
  return (await createActivation(assignment)).id;
}

describe("scoring decision storage (issue #4)", () => {
  it("stores many decisions per activation, each with its own thresholds and reasons", async () => {
    const id = await newActivationId();
    await recordDecision(prisma, id, fakeResponse({ activation_id: id, mode: "t0" }), "submission");
    await recordDecision(
      prisma,
      id,
      fakeResponse({ activation_id: id, mode: "t7", calibrated_probability: 0.7, band: "reject" }),
      "hold_close",
    );

    const all = await decisionsFor(prisma, id);
    expect(all.map((d) => d.mode)).toEqual(["t0", "t7"]);
    expect(all[0].releaseThreshold).toBeCloseTo(0.301471);
    expect(all[1].rejectThreshold).toBeCloseTo(0.666667);
    expect(all[1].reasons).toHaveLength(3);
    expect(all[1].reasons[1]).toMatchObject({ isAgentLevel: true, direction: "lowers", rank: 2 });

    const latest = await latestDecision(prisma, id);
    expect(latest?.band).toBe("reject");
  });

  it("rejects an update to a stored decision", async () => {
    const id = await newActivationId();
    const decision = await recordDecision(prisma, id, fakeResponse({ activation_id: id }), "submission");
    await expect(
      prisma.scoringDecision.update({ where: { id: decision.id }, data: { probability: 0.01 } }),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects deleting a stored decision or reason", async () => {
    const id = await newActivationId();
    const decision = await recordDecision(prisma, id, fakeResponse({ activation_id: id }), "submission");
    await expect(prisma.scoringReason.deleteMany({ where: { decisionId: decision.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(prisma.$executeRaw`DELETE FROM "ScoringDecision" WHERE id = ${decision.id}`).rejects.toThrow(
      /append-only/,
    );
  });

  it("validates responses: thresholds out of order are not a score", () => {
    const body = fakeResponse({ activation_id: "x", release_threshold: 0.9, reject_threshold: 0.2 });
    expect(scoreResponseSchema.safeParse(body).success).toBe(false);
  });
});
