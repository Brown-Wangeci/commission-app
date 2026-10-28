import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth/session";
import { notFound, unauthenticated } from "@/lib/http/errors";
import { withErrors } from "@/lib/http/route";
import { readStored } from "@/lib/evidence/storage";
import { idSchema } from "@/lib/validation";

/**
 * Serves one evidence file. Admins may see any; an agent only their own.
 * Clients see outcomes, not customer photos. A request for evidence the
 * caller may not see is answered as not found.
 */
export const GET = withErrors<{ id: string }>("GET /api/evidence/[id]", async (_request, { params }) => {
  const user = await currentUser();
  if (!user) throw unauthenticated();
  const id = idSchema.parse((await params).id);
  const item = await prisma.evidenceItem.findUnique({ where: { id }, include: { activation: { include: { agent: true } } } });
  const allowed = item && (user.role === "admin" || (user.role === "agent" && item.activation.agent.userId === user.id));
  if (!item || !allowed) throw notFound("Evidence");
  const bytes = await readStored(item.storagePath);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": item.mimeType,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
});
