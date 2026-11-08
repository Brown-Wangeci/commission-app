import type { RoleName } from "@/lib/auth/policy";
import { prisma } from "@/lib/db";
import { ok, withErrors } from "@/lib/http/route";
import { requireAuditAccess } from "./access";
import { auditRecord } from "./history";
import { verifyActivationAudit } from "./verify";

/**
 * The two audit endpoints, mounted once per role under /api/<role>/activations/[id]/audit
 * so each sits behind that role's route protection as well as its own check.
 */
type Params = { id: string };

export function auditRecordRoute(role: RoleName) {
  return withErrors<Params>(`GET /api/${role}/activations/[id]/audit`, async (_request, context) => {
    const { id } = await context.params;
    await requireAuditAccess(role, id);
    return ok({ activationId: id, events: await auditRecord(prisma, id) });
  });
}

export function auditVerifyRoute(role: RoleName) {
  return withErrors<Params>(`POST /api/${role}/activations/[id]/audit/verify`, async (_request, context) => {
    const { id } = await context.params;
    await requireAuditAccess(role, id);
    return ok(await verifyActivationAudit(prisma, id));
  });
}
