import { z } from "zod";
import { agentFor } from "@/lib/auth/actors";
import { requireApiRole } from "@/lib/auth/session";
import { withdrawActivation } from "@/lib/activations/agent-actions";
import { ok, readJson, withErrors } from "@/lib/http/route";
import { idSchema, reasonTextSchema } from "@/lib/validation";

const bodySchema = z.object({ reason: reasonTextSchema });

/** The agent withdraws an activation that has not been decided yet. */
export const POST = withErrors<{ id: string }>("POST /api/agent/activations/[id]/withdraw", async (request, { params }) => {
  const agent = await agentFor(await requireApiRole("agent"));
  const activationId = idSchema.parse((await params).id);
  const { reason } = await readJson(request, bodySchema);
  await withdrawActivation({ agentId: agent.id, activationId, reason });
  return ok({ activationId, state: "withdrawn" });
});
