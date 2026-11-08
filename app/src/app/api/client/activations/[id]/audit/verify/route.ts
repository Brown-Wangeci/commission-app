import { auditVerifyRoute } from "@/lib/audit/routes";

/** Verifies the submission's audit record against the anchored roots, reading the chain itself (FR-22). */
export const POST = auditVerifyRoute("client");
