import { clientFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { ok, readJson, withErrors } from "@/lib/http/route";
import { createJob, jobInputSchema } from "@/lib/jobs/jobs";

/** A client business posts a job with a circular job area. */
export const POST = withErrors("POST /api/client/jobs", async (request) => {
  const user = await requireApiRole("client");
  const client = await clientFor(user);
  const job = await createJob({ clientId: client.id, actorId: user.id, job: await readJson(request, jobInputSchema) });
  return ok({ jobId: job.id }, 201);
});
