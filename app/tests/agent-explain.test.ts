import type { ScoringDecision, ScoringReason } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { explainStatus, type StatusInput } from "@/lib/agents/explain";

function decision(mode: "t0" | "t7", band: "auto_release" | "review" | "reject", probability: number): ScoringDecision & { reasons: ScoringReason[] } {
  return {
    id: `${mode}-1`, activationId: "a", mode, modelVersion: `${mode}_none-isotonic-v1`, featureSet: mode, rawScore: probability,
    probability, band, releaseThreshold: mode === "t7" ? 0.266667 : 0.301471, rejectThreshold: mode === "t7" ? 0.666667 : 0.729167,
    scoredAt: new Date(), recordedAt: new Date(), trigger: "hold_close",
    reasons: [
      { id: "r1", decisionId: "d", rank: 1, feature: "proof_of_activation_missing_flag", description: "no proof of activation was attached", contribution: 1.04, direction: "raises", isAgentLevel: false },
      { id: "r2", decisionId: "d", rank: 2, feature: "agent_tenure_days", description: "the agent has been on the platform 531 days", contribution: -1.01, direction: "lowers", isAgentLevel: true },
    ],
  };
}

const base: StatusInput = {
  state: "held", unscoredStage: null, holdClosesAt: new Date("2026-11-04T07:00:00Z"), decisions: [], closedReviews: [],
  openRequestMessage: null, dispute: null, withdrawReason: null,
};

describe("agent-facing status reasons (issue #11)", () => {
  it("explains a hold with its closing time", () => {
    expect(explainStatus(base).detail).toContain("4 Nov 2026 at 10:00");
  });

  it("quotes the reviewer's reason for a human decision", () => {
    const result = explainStatus({ ...base, state: "approved", closedReviews: [{ action: "approved", reason: "Customer confirmed by phone", closedAt: new Date() }] });
    expect(result).toMatchObject({ headline: "Approved by a reviewer", detail: "Customer confirmed by phone" });
  });

  it("explains an automatic release with the decision's own numbers", () => {
    const result = explainStatus({ ...base, state: "approved", decisions: [decision("t0", "review", 0.49), decision("t7", "auto_release", 0.05)] });
    expect(result.detail).toContain("5.0%");
    expect(result.detail).toContain("26.7%");
  });

  it("explains an automatic refusal with the recorded reason, the model's raising factors, and the right to contest", () => {
    const result = explainStatus({
      ...base,
      state: "refused",
      decisions: [decision("t7", "reject", 0.76)],
      dispute: { status: "open", refusalReason: "Refused automatically at hold-close.", refusedById: null, contestNote: null, resolutionNote: null },
    });
    expect(result.headline).toBe("Refused automatically");
    expect(result.detail).toContain("You can contest this once.");
    expect(result.modelReasons).toEqual(["No proof of activation was attached"]);
  });

  it("shows what a reviewer asked for", () => {
    expect(explainStatus({ ...base, state: "awaiting_evidence", openRequestMessage: "Send the signed form" }).detail).toBe("Send the signed form");
  });

  it("tells the agent when the automatic check could not run", () => {
    expect(explainStatus({ ...base, state: "in_review", unscoredStage: "t0" }).detail).toMatch(/could not run/);
  });
});
