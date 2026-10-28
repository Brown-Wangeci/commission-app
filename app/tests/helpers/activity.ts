import { prisma } from "@/lib/db";

/** Eight days of first-week activity for an activation (days 0 to 7). */
export async function addWeekOfActivity(activationId: string, active = true): Promise<void> {
  await prisma.customerActivityDay.createMany({
    data: Array.from({ length: 8 }, (_, day) => ({
      activationId,
      day,
      customerActive: active,
      transactionCount: active ? 2 : 0,
      topupAmountKsh: active ? 50 : 0,
      usageMinutes: active ? 12 : 0,
      supportContact: false,
      complaintOrRefund: false,
      simActive: true,
    })),
  });
}
