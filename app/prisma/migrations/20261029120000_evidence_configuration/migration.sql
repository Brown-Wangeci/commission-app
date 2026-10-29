-- Issues #46 and #51: per-job evidence configuration, versioned and stored as
-- JSON; the configuration version and the evidence payload on every
-- activation; the field each evidence file belongs to; the job deadline.
--
-- Existing data converts in place. Before this migration every job asked for
-- the same evidence: one to twelve photos, plus the platform's own fields
-- (customer number, SIM date, capture method, proof, note), which stay in
-- their columns. So every existing job gets version 1 of a configuration
-- holding exactly that photo field, and every existing activation is linked
-- to it, with its photos listed under the field in its payload.

-- 1. Configuration versions.
CREATE TABLE "EvidenceConfig" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fields" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EvidenceConfig_jobId_version_key" ON "EvidenceConfig"("jobId", "version");
CREATE UNIQUE INDEX "EvidenceConfig_id_jobId_key" ON "EvidenceConfig"("id", "jobId");
ALTER TABLE "EvidenceConfig" ADD CONSTRAINT "EvidenceConfig_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvidenceConfig" ADD CONSTRAINT "EvidenceConfig_version_positive" CHECK ("version" >= 1);
ALTER TABLE "EvidenceConfig" ADD CONSTRAINT "EvidenceConfig_fields_is_array" CHECK (jsonb_typeof("fields") = 'array');

-- A version, once written, never changes: past submissions are judged by it.
CREATE TRIGGER "EvidenceConfig_append_only"
  BEFORE UPDATE OR DELETE ON "EvidenceConfig"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_reject_mutation();

INSERT INTO "EvidenceConfig" ("id", "jobId", "version", "fields", "createdById", "createdAt")
SELECT
  'ec' || replace(gen_random_uuid()::text, '-', ''),
  j.id,
  1,
  '[{"key": "field_1", "label": "Photos", "type": "photo", "mandatory": true,
     "help": "Photos of the activation, as every job asked for before evidence fields could be configured.",
     "format": {"minCount": 1, "maxCount": 12}}]'::jsonb,
  NULL,
  j."createdAt"
FROM "Job" j;

-- 2. Each evidence file's field.
ALTER TABLE "EvidenceItem" ADD COLUMN "fieldKey" TEXT;
UPDATE "EvidenceItem" SET "fieldKey" = 'field_1' WHERE "kind" = 'photo' AND "evidenceRequestId" IS NULL;
UPDATE "EvidenceItem" SET "fieldKey" = 'proof' WHERE "kind" = 'proof';

-- 3. Each activation's configuration version and payload.
ALTER TABLE "Activation" ADD COLUMN "evidenceConfigId" TEXT, ADD COLUMN "evidencePayload" JSONB;

UPDATE "Activation" a
SET "evidenceConfigId" = c.id,
    "evidencePayload" = jsonb_build_object(
      'field_1',
      COALESCE((
        SELECT jsonb_agg(e."sequence" ORDER BY e."sequence")
        FROM "EvidenceItem" e
        WHERE e."activationId" = a.id AND e."fieldKey" = 'field_1'
      ), '[]'::jsonb)
    )
FROM "EvidenceConfig" c
WHERE c."jobId" = a."jobId" AND c."version" = 1;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Activation" WHERE "evidenceConfigId" IS NULL OR "evidencePayload" IS NULL) THEN
    RAISE EXCEPTION 'ledgerfield migration: an activation was not linked to an evidence configuration';
  END IF;
END;
$$;

ALTER TABLE "Activation"
  ALTER COLUMN "evidenceConfigId" SET NOT NULL,
  ALTER COLUMN "evidencePayload" SET NOT NULL;
ALTER TABLE "Activation" ADD CONSTRAINT "Activation_evidence_payload_is_object" CHECK (jsonb_typeof("evidencePayload") = 'object');
-- The version must belong to the activation's own job.
ALTER TABLE "Activation" ADD CONSTRAINT "Activation_evidenceConfigId_jobId_fkey"
  FOREIGN KEY ("evidenceConfigId", "jobId") REFERENCES "EvidenceConfig"("id", "jobId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What a submission was validated against, and what it said, are fixed once
-- written (DR-07); the activation's state and timestamps still change.
CREATE FUNCTION ledgerfield_activation_evidence_fixed() RETURNS trigger AS $$
BEGIN
  IF NEW."evidenceConfigId" IS DISTINCT FROM OLD."evidenceConfigId"
     OR NEW."evidencePayload" IS DISTINCT FROM OLD."evidencePayload" THEN
    RAISE EXCEPTION 'ledgerfield: a submission''s evidence and its configuration version cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Activation_evidence_fixed"
  BEFORE UPDATE OF "evidenceConfigId", "evidencePayload" ON "Activation"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_activation_evidence_fixed();

-- 4. The job deadline (FR-04). Existing jobs had none and keep none; every
-- job published from now on must have one. Like the commission terms, it is
-- fixed once the job is published.
ALTER TABLE "Job" ADD COLUMN "deadlineAt" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION ledgerfield_job_terms_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW."clientId", NEW."submissionValueCents", NEW."commissionRateBps", NEW."flatCommissionCents", NEW."slots", NEW."escrowLockedCents")
     IS DISTINCT FROM
     (OLD."clientId", OLD."submissionValueCents", OLD."commissionRateBps", OLD."flatCommissionCents", OLD."slots", OLD."escrowLockedCents") THEN
    RAISE EXCEPTION 'ledgerfield: a published job''s commission structure, slots and escrow lock cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."deadlineAt" IS DISTINCT FROM OLD."deadlineAt" THEN
    RAISE EXCEPTION 'ledgerfield: a published job''s deadline cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'closed' AND (NEW."status" <> 'closed' OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt") THEN
    RAISE EXCEPTION 'ledgerfield: a closed job cannot be reopened'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
