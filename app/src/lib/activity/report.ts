import { z } from "zod";
import { prisma } from "@/lib/db";
import { conflict, notFound } from "@/lib/http/errors";
import { isFinal } from "@/lib/activations/states";
import { recordAuditEvent } from "@/lib/activations/transition";
import { centsSchema } from "@/lib/validation";

/**
 * First-week customer activity, reported by the client business whose
 * service the customer signed up for. The T7 model reads it at hold-close.
 * A report replaces any earlier report for the same days. The customer's
 * top-up is money, so it arrives and is stored as integer cents (issue #40).
 */
export const activityDaySchema = z.object({
  day: z.coerce.number().int().min(0).max(7),
  customerActive: z.boolean(),
  transactionCount: z.coerce.number().int().min(0).max(100000),
  topupCents: centsSchema("The top-up").max(1_000_000_000, "The top-up is larger than KSh 10,000,000.00."),
  usageMinutes: z.coerce.number().min(0).max(24 * 60),
  supportContact: z.boolean(),
  complaintOrRefund: z.boolean(),
  simActive: z.boolean(),
});

export const activityReportSchema = z.object({
  days: z
    .array(activityDaySchema)
    .min(1, "Report at least one day.")
    .max(8)
    .refine((days) => new Set(days.map((d) => d.day)).size === days.length, "Each day may appear once."),
});

export type ActivityReport = z.infer<typeof activityReportSchema>;

export async function reportActivity(input: {
  clientId: string;
  activationId: string;
  report: ActivityReport;
  actorId: string;
}): Promise<number> {
  const activation = await prisma.activation.findUnique({
    where: { id: input.activationId },
    include: { job: true },
  });
  if (!activation || activation.job.clientId !== input.clientId) throw notFound("Activation");
  if (isFinal(activation.state)) throw conflict("This activation is already decided; activity can no longer change it.");

  await prisma.$transaction(async (tx) => {
    for (const day of input.report.days) {
      await tx.customerActivityDay.upsert({
        where: { activationId_day: { activationId: activation.id, day: day.day } },
        create: { activationId: activation.id, ...day },
        update: { ...day, reportedAt: new Date() },
      });
    }
    await recordAuditEvent(tx, {
      kind: "activity_reported",
      activationId: activation.id,
      actorId: input.actorId,
      detail: `First-week activity reported for ${input.report.days.length} day(s).`,
    });
  });
  return input.report.days.length;
}
