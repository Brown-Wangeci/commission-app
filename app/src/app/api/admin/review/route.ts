import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireApiRole } from "@/lib/auth/session";
import { ok, withErrors } from "@/lib/http/route";
import { listQueue } from "@/lib/review/queue";

const querySchema = z.object({ tab: z.enum(["waiting", "evidence"]).default("waiting") });

/** The review queue: activations waiting for a reviewer, or waiting on the agent for evidence. */
export const GET = withErrors("GET /api/admin/review", async (request) => {
  await requireApiRole("admin");
  const { tab } = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
  return ok({ tab, items: await listQueue(prisma, tab) });
});
