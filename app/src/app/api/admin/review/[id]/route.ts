import { prisma } from "@/lib/db";
import { requireApiRole } from "@/lib/auth/session";
import { ok, withErrors } from "@/lib/http/route";
import { reviewDetail } from "@/lib/review/detail";
import { idSchema } from "@/lib/validation";

/** Everything the review screen shows for one activation. */
export const GET = withErrors<{ id: string }>("GET /api/admin/review/[id]", async (_request, { params }) => {
  await requireApiRole("admin");
  return ok(await reviewDetail(prisma, idSchema.parse((await params).id)));
});
