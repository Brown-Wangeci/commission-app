import { prisma } from "@/lib/db";
import { conflict, notFound } from "@/lib/http/errors";
import { recordAuditEvent } from "@/lib/activations/transition";
import { enqueueScoring } from "./jobs";
import { runScoringJob, type RunOutcome } from "./runner";

const FORCEABLE = ["held", "in_review", "awaiting_evidence", "disputed"] as const;

/**
 * Admin control: score an activation with the T7 model now instead of
 * waiting for the hold window. On a held activation this closes the hold
 * early and the band is applied; on one a reviewer already owns, the score is
 * advisory and only shown. Uses the same durable job as the scheduler, so a
 * forced run and a scheduled run cannot both happen.
 */
export async function forceT7(activationId: string, adminId: string, now: Date = new Date()): Promise<RunOutcome> {
  const activation = await prisma.activation.findUnique({ where: { id: activationId } });
  if (!activation) throw notFound("Activation");
  if (!(FORCEABLE as readonly string[]).includes(activation.state)) {
    throw conflict(`An activation that is ${activation.state} cannot be scored at hold-close.`);
  }
  const job = await prisma.$transaction(async (tx) => {
    const scheduled = await enqueueScoring(tx, { activationId, mode: "t7", dueAt: now, trigger: "admin_forced" });
    await recordAuditEvent(tx, {
      kind: "t7_forced",
      activationId,
      actorId: adminId,
      detail:
        activation.state === "held"
          ? "Hold-close (T7) scoring forced by an administrator before the hold window closed."
          : "Advisory hold-close (T7) score requested by an administrator.",
      at: now,
    });
    return scheduled;
  });
  return runScoringJob(job.id, now);
}
