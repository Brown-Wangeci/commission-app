import { z } from "zod";
import { agentFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { contestRefusal } from "@/lib/disputes/disputes";
import { ok, readJson, withErrors } from "@/lib/http/route";
import { idSchema, reasonTextSchema } from "@/lib/validation";

const bodySchema = z.object({ note: reasonTextSchema });

/** The agent contests a refusal once; it goes back to a reviewer as disputed. */
export const POST = withErrors<{ id: string }>("POST /api/agent/activations/[id]/contest", async (request, { params }) => {
  const agent = await agentFor(await requireApiRole("agent"));
  const activationId = idSchema.parse((await params).id);
  const { note } = await readJson(request, bodySchema);
  await contestRefusal({ agentId: agent.id, activationId, note });
  return ok({ activationId, state: "disputed" });
});
