import { agentFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { parseSubmissionForm } from "@/lib/activations/submission-form";
import { submitActivation } from "@/lib/activations/submit";
import { badRequest } from "@/lib/http/errors";
import { ok, withErrors } from "@/lib/http/route";

/**
 * Vercel Hobby's function limit with Fluid Compute (Vercel docs). The scoring
 * call inside is bounded well below it: SCORING_IMMEDIATE_ATTEMPTS x
 * SCORING_TIMEOUT_MS plus backoff (46.5 s with the defaults), after which the
 * activation goes to review as unscored.
 */
export const maxDuration = 300;

/** Submit an activation with evidence (multipart/form-data). Scores it at T0. */
export const POST = withErrors("POST /api/agent/activations", async (request) => {
  const user = await requireApiRole("agent");
  const agent = await agentFor(user);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw badRequest("Send the submission as multipart/form-data.");
  }
  const result = await submitActivation(parseSubmissionForm(form, agent.id));
  return ok(result, 201);
});
