import { agentFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { respondToEvidenceRequest } from "@/lib/activations/agent-actions";
import { photoInputs } from "@/lib/activations/submission-form";
import { badRequest } from "@/lib/http/errors";
import { ok, withErrors } from "@/lib/http/route";
import { idSchema } from "@/lib/validation";

/** The agent answers an evidence request (multipart: note, photos, photoMeta). */
export const POST = withErrors<{ id: string }>("POST /api/agent/activations/[id]/evidence", async (request, { params }) => {
  const agent = await agentFor(await requireApiRole("agent"));
  const activationId = idSchema.parse((await params).id);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw badRequest("Send the response as multipart/form-data.");
  }
  const rawNote = form.get("note");
  const note = typeof rawNote === "string" && rawNote.trim() ? rawNote.trim().slice(0, 2000) : null;
  await respondToEvidenceRequest({ agentId: agent.id, activationId, note, photos: photoInputs(form) });
  return ok({ activationId, state: "in_review" });
});
