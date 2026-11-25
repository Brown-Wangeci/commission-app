import { requireApiRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { ok, withErrors } from "@/lib/http/route";
import { exportReviewLabels } from "@/lib/labels/export";

/**
 * DR-10. Every reviewed submission as a labelled record: the feature vector
 * the model scored and the final human decision as the label. Administrators
 * only, and the rows carry no personal data (src/lib/labels/export.ts).
 */
export const GET = withErrors("GET /api/admin/labels/export", async () => {
  await requireApiRole("admin");
  return ok(await exportReviewLabels(prisma));
});
