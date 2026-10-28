import type { ActivationState } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ALL_STATES, TRANSITIONS, isLegalTransition, transitionPairs } from "@/lib/activations/states";
import { transitionActivation } from "@/lib/activations/transition";
import { resetDatabase } from "./helpers/db";
import { createActivation, createScenario, createUser } from "./helpers/factories";

beforeEach(resetDatabase);

/** A path through legal transitions from submitted to every state. */
const PATH_TO: Record<ActivationState, ActivationState[]> = {
  submitted: [],
  scored_t0: ["scored_t0"],
  held: ["scored_t0", "held"],
  scored_t7: ["scored_t0", "held", "scored_t7"],
  in_review: ["scored_t0", "held", "scored_t7", "in_review"],
  awaiting_evidence: ["scored_t0", "held", "scored_t7", "in_review", "awaiting_evidence"],
  approved: ["scored_t0", "held", "scored_t7", "approved"],
  refused: ["scored_t0", "held", "scored_t7", "refused"],
  disputed: ["scored_t0", "held", "scored_t7", "refused", "disputed"],
  withdrawn: ["scored_t0", "held", "withdrawn"],
};

async function activationIn(state: ActivationState): Promise<string> {
  const { assignment } = await createScenario();
  const activation = await createActivation(assignment);
  let current: ActivationState = "submitted";
  for (const next of PATH_TO[state]) {
    await prisma.$transaction((tx) =>
      transitionActivation(tx, { activationId: activation.id, from: current, to: next }),
    );
    current = next;
  }
  return activation.id;
}

/** A write that skips all application code. */
function rawSetState(id: string, state: ActivationState) {
  return prisma.$executeRawUnsafe(
    `UPDATE "Activation" SET state = $1::"ActivationState" WHERE id = $2`,
    state,
    id,
  );
}

describe("activation state machine (issue #3)", () => {
  it("has the same transition table in the database as in code", async () => {
    const rows = await prisma.activationTransitionRule.findMany();
    const inDatabase = rows.map((r) => `${r.fromState}->${r.toState}`).sort();
    const inCode = transitionPairs().map(([from, to]) => `${from}->${to}`).sort();
    expect(inDatabase).toEqual(inCode);
  });

  it("accepts every legal transition", async () => {
    for (const [from, to] of transitionPairs()) {
      const id = await activationIn(from);
      await prisma.$transaction((tx) => transitionActivation(tx, { activationId: id, from, to }));
      const after = await prisma.activation.findUniqueOrThrow({ where: { id } });
      expect(after.state).toBe(to);
    }
  });

  it("rejects every illegal transition when written directly to the database", async () => {
    const samples: Array<[ActivationState, ActivationState]> = [];
    for (const from of ALL_STATES) {
      const illegal = ALL_STATES.filter((to) => to !== from && !isLegalTransition(from, to));
      samples.push(...illegal.map((to): [ActivationState, ActivationState] => [from, to]));
    }
    expect(samples.length).toBeGreaterThan(50);
    const ids = new Map<ActivationState, string>();
    for (const state of ALL_STATES) ids.set(state, await activationIn(state));

    for (const [from, to] of samples) {
      await expect(rawSetState(ids.get(from)!, to), `${from} -> ${to}`).rejects.toThrow(
        /illegal activation transition/,
      );
    }
  });

  it("rejects the headline illegal moves through the ORM as well", async () => {
    const submitted = await activationIn("submitted");
    await expect(
      prisma.activation.update({ where: { id: submitted }, data: { state: "approved" } }),
    ).rejects.toThrow(/illegal activation transition submitted -> approved/);
    const approved = await activationIn("approved");
    await expect(rawSetState(approved, "refused")).rejects.toThrow(/approved -> refused/);
  });

  it("refuses to create an activation in any state but submitted", async () => {
    const { assignment } = await createScenario();
    await expect(createActivation(assignment, { state: "approved" })).rejects.toThrow(
      /illegal activation transition \(new\) -> approved/,
    );
  });

  it("is a compare-and-swap: a stale caller cannot overwrite a newer decision", async () => {
    const id = await activationIn("in_review");
    await prisma.$transaction((tx) => transitionActivation(tx, { activationId: id, from: "in_review", to: "approved" }));
    await expect(
      prisma.$transaction((tx) => transitionActivation(tx, { activationId: id, from: "in_review", to: "refused" })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("writes every transition to the audit log with actor and note", async () => {
    const reviewer = await createUser("admin");
    const id = await activationIn("in_review");
    await prisma.$transaction((tx) =>
      transitionActivation(tx, {
        activationId: id, from: "in_review", to: "approved", actorId: reviewer.id, note: "photos check out",
      }),
    );
    const events = await prisma.auditEvent.findMany({ where: { activationId: id }, orderBy: { id: "asc" } });
    expect(events.map((e) => e.toState)).toEqual(["submitted", ...PATH_TO.in_review, "approved"]);
    expect(events.at(-1)).toMatchObject({ fromState: "in_review", actorId: reviewer.id, detail: "photos check out" });
  });

  it("logs a direct database write too, so no state change goes unrecorded", async () => {
    const id = await activationIn("in_review");
    await rawSetState(id, "refused");
    const last = await prisma.auditEvent.findFirstOrThrow({ where: { activationId: id }, orderBy: { id: "desc" } });
    expect(last).toMatchObject({ fromState: "in_review", toState: "refused", actorId: null });
  });

  it("marks approved and withdrawn as final", () => {
    expect(TRANSITIONS.approved).toEqual([]);
    expect(TRANSITIONS.withdrawn).toEqual([]);
  });
});
