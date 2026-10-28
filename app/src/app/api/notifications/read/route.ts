import { z } from "zod";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth/session";
import { unauthenticated } from "@/lib/http/errors";
import { ok, readJson, withErrors } from "@/lib/http/route";
import { markRead } from "@/lib/notifications";
import { idSchema } from "@/lib/validation";

const bodySchema = z.object({ ids: z.array(idSchema).min(1).max(100) });

/** Marks the caller's own notifications as read. */
export const POST = withErrors("POST /api/notifications/read", async (request) => {
  const user = await currentUser();
  if (!user) throw unauthenticated();
  const { ids } = await readJson(request, bodySchema);
  return ok({ marked: await markRead(prisma, user.id, ids) });
});
