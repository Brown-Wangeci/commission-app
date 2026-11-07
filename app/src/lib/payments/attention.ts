import type { Tx } from "@/lib/db";
import { notify } from "@/lib/notifications";

/** Doubling delay: base, then twice the base, and so on, after each failed try. */
export function backoffMs(baseSeconds: number, tries: number): number {
  return baseSeconds * 1000 * 2 ** Math.max(tries - 1, 0);
}

/** Tells every administrator that a payment needs a person (IR-03, D2). */
export async function raiseToAdministrators(tx: Tx, input: { message: string; activationId?: string | null }): Promise<void> {
  const admins = await tx.user.findMany({ where: { role: "admin" }, select: { id: true } });
  for (const admin of admins) {
    await notify(tx, { userId: admin.id, kind: "payment_attention", message: input.message, activationId: input.activationId });
  }
}
