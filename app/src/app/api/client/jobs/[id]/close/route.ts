import { clientFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { ok, withErrors } from "@/lib/http/route";
import { closeJob } from "@/lib/jobs/jobs";
import { idSchema } from "@/lib/validation";

/** The client closes a job; its unspent remainder returns to the client's available balance. */
export const POST = withErrors<{ id: string }>("POST /api/client/jobs/[id]/close", async (_request, { params }) => {
  const user = await requireApiRole("client");
  const client = await clientFor(user);
  const jobId = idSchema.parse((await params).id);
  const result = await closeJob({ jobId, clientId: client.id, actorId: user.id });
  return ok({ jobId: result.job.id, returnedCents: result.returnedCents, returnedDerivation: result.returnedDerivation });
});
