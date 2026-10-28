import { z } from "zod";
import { clientFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { fundJob } from "@/lib/escrow/holds";
import { ok, readJson, withErrors } from "@/lib/http/route";
import { idSchema } from "@/lib/validation";

const bodySchema = z.object({ amountKsh: z.coerce.number().int("Use whole shillings.").min(1).max(100_000_000) });

/** The client adds money to a job's escrow. */
export const POST = withErrors<{ id: string }>("POST /api/client/jobs/[id]/fund", async (request, { params }) => {
  const user = await requireApiRole("client");
  const client = await clientFor(user);
  const jobId = idSchema.parse((await params).id);
  const { amountKsh } = await readJson(request, bodySchema);
  const deposit = await fundJob({ jobId, clientId: client.id, amountKsh, actorId: user.id });
  return ok({ depositId: deposit.id, amountKsh: deposit.amountKsh }, 201);
});
