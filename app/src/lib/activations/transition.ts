import type { ActivationState, Prisma } from "@prisma/client";
import { ApiError } from "@/lib/http/errors";
import { isLegalTransition } from "./states";

export type TransitionInput = {
  activationId: string;
  from: ActivationState;
  to: ActivationState;
  actorId?: string | null;
  note?: string | null;
  /** When the transition happened; defaults to now. Used by the seed to replay history. */
  at?: Date;
  /** Other activation columns to change in the same write. */
  data?: Prisma.ActivationUpdateManyMutationInput;
};

export class IllegalTransitionError extends ApiError {
  constructor(from: ActivationState, to: ActivationState, reason: string) {
    super(409, "illegal_transition", `Cannot move an activation from ${from} to ${to}: ${reason}`, { from, to });
  }
}

/**
 * Passes who is acting, why, and when to the database trigger, which writes
 * the audit row. set_config(..., true) lasts until the end of the current
 * transaction, so this must run inside one.
 */
export async function setAuditContext(
  tx: Prisma.TransactionClient,
  input: Pick<TransitionInput, "actorId" | "note" | "at">,
): Promise<void> {
  const at = input.at ? input.at.toISOString().replace("Z", "") : "";
  await tx.$queryRaw`SELECT
    set_config('ledgerfield.actor_id', ${input.actorId ?? ""}, true),
    set_config('ledgerfield.note', ${input.note ?? ""}, true),
    set_config('ledgerfield.at', ${at}, true)`;
}

/**
 * Moves one activation from `from` to `to` as a compare-and-swap: the write
 * only succeeds if the activation is still in `from`, so two reviewers acting
 * at once cannot both succeed. The database trigger independently rejects any
 * pair not in the transition table, even for writes that skip this function.
 */
export async function transitionActivation(tx: Prisma.TransactionClient, input: TransitionInput): Promise<void> {
  if (!isLegalTransition(input.from, input.to)) {
    throw new IllegalTransitionError(input.from, input.to, "that transition is not allowed");
  }
  await setAuditContext(tx, input);
  const result = await tx.activation.updateMany({
    where: { id: input.activationId, state: input.from },
    data: { ...input.data, state: input.to },
  });
  if (result.count === 0) {
    throw new IllegalTransitionError(input.from, input.to, "it is no longer in that state");
  }
}

/** Records a non-transition event in the audit log. */
export async function recordAuditEvent(
  tx: Prisma.TransactionClient,
  event: { kind: string; activationId?: string | null; actorId?: string | null; detail: string; at?: Date },
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      kind: event.kind,
      activationId: event.activationId ?? null,
      actorId: event.actorId ?? null,
      detail: event.detail,
      at: event.at ?? new Date(),
    },
  });
}
