import { requireApiRole } from "@/lib/auth/session";
import { ok, withErrors } from "@/lib/http/route";
import { idSchema } from "@/lib/validation";
import { forceT7 } from "@/lib/scoring/force";
import { prisma } from "@/lib/db";

/** Admin control: score this activation with the T7 model now. */
export const POST = withErrors<{ id: string }>("POST /api/admin/activations/[id]/score-t7", async (_request, { params }) => {
  const admin = await requireApiRole("admin");
  const id = idSchema.parse((await params).id);
  const outcome = await forceT7(id, admin.id);
  const activation = await prisma.activation.findUniqueOrThrow({ where: { id }, select: { state: true, unscoredStage: true } });
  return ok({ outcome, state: activation.state, unscoredStage: activation.unscoredStage });
});
