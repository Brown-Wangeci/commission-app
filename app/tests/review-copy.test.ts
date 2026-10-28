import { describe, expect, it } from "vitest";
import { whyHere, MODEL_FRAMING, CLOSING_LINE } from "@/lib/review/copy";
import { agentShare, biggestConcern, splitByLevel, type ReasonView } from "@/lib/review/reasons";
import type { DecisionView } from "@/lib/review/detail";

function decision(overrides: Partial<DecisionView>): DecisionView {
  return {
    id: "d1", mode: "t7", modelVersion: "t7_none-isotonic-v1", probability: 0.382, band: "review",
    releaseThreshold: 0.266667, rejectThreshold: 0.666667, scoredAt: new Date(), trigger: "hold_close", reasons: [],
    ...overrides,
  };
}

const reason = (rank: number, contribution: number, isAgentLevel: boolean): ReasonView => ({
  rank, feature: `f${rank}`, description: `factor ${rank}`, contribution, raisesRisk: contribution > 0, isAgentLevel,
});

describe("review screen copy (issue #12, correction 1)", () => {
  it("states the cut-offs of the decision it describes, not fixed numbers", () => {
    expect(whyHere("band_review", decision({}), null)).toBe(
      "At 38.2% it falls between the auto-approve cut-off (26.7%) and the auto-reject cut-off (66.7%), so it was sent to a person.",
    );
    const t0 = decision({ mode: "t0", probability: 0.747, band: "reject", releaseThreshold: 0.301471, rejectThreshold: 0.729167 });
    expect(whyHere("t0_reject_escalation", t0, null)).toContain("above the auto-reject cut-off (72.9%)");
    const other = decision({ releaseThreshold: 0.1, rejectThreshold: 0.9, probability: 0.5 });
    expect(whyHere("band_review", other, null)).toContain("(10.0%)");
    expect(whyHere("band_review", other, null)).toContain("(90.0%)");
  });

  it("says a score is unavailable rather than inventing one", () => {
    expect(whyHere("could_not_be_scored", null, "t0")).toMatch(/^No score/);
  });

  it("keeps the framing and never claims decisions retrain the model (correction 2)", () => {
    expect(MODEL_FRAMING).toBe("An automated check against patterns in past submissions, which gives advice only and never moves money.");
    expect(CLOSING_LINE).toMatch(/recorded and shared with the agent and the client/);
    expect(`${MODEL_FRAMING} ${CLOSING_LINE}`.toLowerCase()).not.toMatch(/retrain|learn|improve the model|feedback/);
  });
});

describe("factor handling (correction 4)", () => {
  const reasons = [reason(1, 1.04, false), reason(2, -1.01, true), reason(3, 0.95, false)];

  it("picks the largest risk-raising factor as the biggest concern", () => {
    expect(biggestConcern(reasons)?.rank).toBe(1);
    expect(biggestConcern([reason(1, -0.5, false)])).toBeNull();
  });

  it("keeps agent-level factors apart from submission factors, each by magnitude", () => {
    const { submission, agent } = splitByLevel(reasons);
    expect(submission.map((r) => r.rank)).toEqual([1, 3]);
    expect(agent.map((r) => r.rank)).toEqual([2]);
  });

  it("reports the agent share of the explanation from the factors themselves", () => {
    expect(agentShare(reasons)).toBeCloseTo(1.01 / 3.0, 5);
    expect(agentShare([])).toBeNull();
  });
});
