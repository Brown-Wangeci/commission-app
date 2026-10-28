import { z } from "zod";
import { prisma } from "@/lib/db";
import { notFound } from "@/lib/http/errors";
import { recordAuditEvent } from "@/lib/activations/transition";
import { escrowBalance } from "@/lib/escrow/holds";
import { explainStatus } from "@/lib/agents/explain";
import { latitudeSchema, longitudeSchema, nameSchema } from "@/lib/validation";

/**
 * Jobs posted by client businesses. The commission rate is entered as a
 * percentage and stored as a fraction; it is passed to the scoring service
 * with each activation but is not a model feature.
 */
export const jobInputSchema = z.object({
  title: nameSchema,
  description: z.string().trim().min(10, "Describe the job in at least 10 characters.").max(2000),
  areaName: nameSchema,
  areaLat: latitudeSchema,
  areaLon: longitudeSchema,
  areaRadiusM: z.coerce.number().int().min(50, "Use a radius of at least 50 m.").max(50_000, "Use a radius of at most 50 km."),
  payoutPerActivationKsh: z.coerce.number().int("Use whole shillings.").min(1).max(1_000_000),
  commissionRatePercent: z.coerce.number().gt(0).max(100),
  slots: z.coerce.number().int().min(1).max(10_000),
  initialFundingKsh: z.coerce.number().int().min(0).max(100_000_000).default(0),
});

export type JobInput = z.infer<typeof jobInputSchema>;

export async function createJob(input: { clientId: string; actorId: string; job: JobInput }) {
  const { job } = input;
  return prisma.$transaction(async (tx) => {
    const created = await tx.job.create({
      data: {
        clientId: input.clientId,
        title: job.title,
        description: job.description,
        areaName: job.areaName,
        areaLat: job.areaLat,
        areaLon: job.areaLon,
        areaRadiusM: job.areaRadiusM,
        payoutPerActivationKsh: job.payoutPerActivationKsh,
        commissionRate: job.commissionRatePercent / 100,
        slots: job.slots,
      },
    });
    if (job.initialFundingKsh > 0) {
      await tx.escrowDeposit.create({ data: { jobId: created.id, amountKsh: job.initialFundingKsh, createdById: input.actorId } });
    }
    await recordAuditEvent(tx, {
      kind: "job_posted",
      actorId: input.actorId,
      detail: `Job "${created.title}" posted with ${created.slots} slot(s) at KSh ${created.payoutPerActivationKsh}${job.initialFundingKsh > 0 ? `; KSh ${job.initialFundingKsh} deposited` : ""}.`,
    });
    return created;
  });
}

const activationInclude = {
  agent: { include: { user: true } },
  decisions: { orderBy: { recordedAt: "asc" as const }, include: { reasons: true } },
  reviewItems: { orderBy: { openedAt: "asc" as const } },
  evidenceRequests: { orderBy: { requestedAt: "asc" as const } },
  dispute: true,
  _count: { select: { activity: true } },
};

/** The client's jobs with escrow balances and outcome counts. */
export async function clientJobs(clientId: string) {
  const jobs = await prisma.job.findMany({
    where: { clientId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { assignments: true } } },
  });
  const outcomes = await prisma.activation.groupBy({ by: ["jobId", "state"], where: { job: { clientId } }, _count: { _all: true } });
  return Promise.all(
    jobs.map(async (job) => ({
      job,
      balance: await escrowBalance(prisma, job.id),
      outcomes: Object.fromEntries(outcomes.filter((o) => o.jobId === job.id).map((o) => [o.state, o._count._all])),
    })),
  );
}

/** One job of this client, with every activation on it and the reason for its outcome. */
export async function clientJob(clientId: string, jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.clientId !== clientId) throw notFound("Job");
  const [balance, activations, deposits] = await Promise.all([
    escrowBalance(prisma, job.id),
    prisma.activation.findMany({ where: { jobId }, include: activationInclude, orderBy: { submittedAt: "desc" } }),
    prisma.escrowDeposit.findMany({ where: { jobId }, orderBy: { createdAt: "desc" } }),
  ]);
  return {
    job,
    balance,
    deposits,
    activations: activations.map((activation) => ({
      activation,
      explanation: explainStatus(
        {
          state: activation.state,
          unscoredStage: activation.unscoredStage,
          holdClosesAt: activation.holdClosesAt,
          decisions: activation.decisions,
          closedReviews: activation.reviewItems.filter((item) => item.closedAt !== null),
          openRequestMessage: activation.evidenceRequests.findLast((r) => r.status === "open")?.message ?? null,
          dispute: activation.dispute,
          withdrawReason: activation.reviewItems.findLast((item) => item.action === "withdrawn_by_agent")?.reason ?? null,
        },
        "client",
      ),
    })),
  };
}

/** An activation on one of this client's jobs, with any activity already reported. */
export async function clientActivationForActivity(clientId: string, activationId: string) {
  const activation = await prisma.activation.findUnique({
    where: { id: activationId },
    include: { job: true, activity: { orderBy: { day: "asc" } } },
  });
  if (!activation || activation.job.clientId !== clientId) throw notFound("Activation");
  return activation;
}
