import { auditRecordRoute } from "@/lib/audit/routes";

/** The submission's audit record: every event, its hash, and where it stands on chain (FR-22). */
export const GET = auditRecordRoute("admin");
