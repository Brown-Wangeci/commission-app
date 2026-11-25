-- DR-11: retention limit, then anonymisation of the off-chain record.
--
-- "Activation"."anonymisedAt" records when a submission's personal data was
-- removed, so a second run does nothing. Additive: every existing row is
-- NULL, which means "not anonymised".
--
-- The audit chain is NOT touched by any of this. "AuditEvent" stays
-- append-only and its anchored hashes stay valid; what the chain still holds
-- is stated in docs/RETENTION.md.

-- AlterTable
ALTER TABLE "Activation" ADD COLUMN "anonymisedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Activation_anonymisedAt_state_idx" ON "Activation"("anonymisedAt", "state");

-- The one change the retention job makes to a submission's evidence payload:
-- every value a person typed becomes null, and a photo field's list of
-- evidence numbers is kept, so the record still says which photos answered
-- which field. Nothing else about the payload may change, ever.
CREATE FUNCTION ledgerfield_cleared_payload(payload jsonb) RETURNS jsonb AS $$
  SELECT COALESCE(
    jsonb_object_agg(key, CASE WHEN jsonb_typeof(value) = 'array' THEN value ELSE 'null'::jsonb END),
    '{}'::jsonb)
  FROM jsonb_each(payload);
$$ LANGUAGE sql IMMUTABLE;

-- Replaces the guard from 20261029120000. What a submission was validated
-- against is still fixed (DR-07), and what it said is still fixed, with the
-- single exception above, allowed only on the update that anonymises the row
-- (DR-11). "anonymisedAt" is write-once, so no row can be anonymised twice or
-- have its payload cleared a second time.
CREATE OR REPLACE FUNCTION ledgerfield_activation_evidence_fixed() RETURNS trigger AS $$
DECLARE
  is_anonymising boolean := OLD."anonymisedAt" IS NULL AND NEW."anonymisedAt" IS NOT NULL;
BEGIN
  IF OLD."anonymisedAt" IS NOT NULL AND NEW."anonymisedAt" IS DISTINCT FROM OLD."anonymisedAt" THEN
    RAISE EXCEPTION 'ledgerfield: a submission is anonymised once and cannot be un-anonymised'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."evidenceConfigId" IS DISTINCT FROM OLD."evidenceConfigId" THEN
    RAISE EXCEPTION 'ledgerfield: a submission''s evidence configuration version cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."evidencePayload" IS DISTINCT FROM OLD."evidencePayload"
     AND NOT (is_anonymising AND NEW."evidencePayload" = ledgerfield_cleared_payload(OLD."evidencePayload")) THEN
    RAISE EXCEPTION 'ledgerfield: a submission''s evidence cannot change, except to be cleared when it is anonymised'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "Activation_evidence_fixed" ON "Activation";
CREATE TRIGGER "Activation_evidence_fixed"
  BEFORE UPDATE OF "evidenceConfigId", "evidencePayload", "anonymisedAt" ON "Activation"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_activation_evidence_fixed();

-- A paid disbursement's payout number may be replaced by its masked form, and
-- nothing else about the instruction may change. Without this the guard from
-- 20261108090000 refuses the write, because a payout number Daraja may still
-- act on must never change. A paid row is settled: nothing is sent again.
CREATE OR REPLACE FUNCTION ledgerfield_disbursement_guard() RETURNS trigger AS $$
DECLARE
  is_retry boolean := OLD.status = 'failed' AND NEW.status = 'queued'
    AND NEW.generation = OLD.generation + 1
    AND NEW.reference <> OLD.reference
    AND NEW."previousReferences" = array_append(OLD."previousReferences", OLD.reference)
    AND NEW."conversationId" IS NULL AND NEW.receipt IS NULL;
  -- DR-11: masking the payout number of a settled payment.
  is_masking boolean := OLD.status = 'paid' AND NEW.status = 'paid'
    AND NEW."payoutMsisdn" <> OLD."payoutMsisdn"
    AND NEW."payoutMsisdn" ~ '^[0-9]{2,4}\*{6}[0-9]{3}$';
BEGIN
  IF NEW."activationId" <> OLD."activationId" OR NEW."commissionId" <> OLD."commissionId"
     OR NEW."authorisationId" <> OLD."authorisationId"
     OR NEW."amountCents" <> OLD."amountCents"
     OR (NEW."payoutMsisdn" <> OLD."payoutMsisdn" AND NOT is_masking) THEN
    RAISE EXCEPTION 'ledgerfield: a disbursement''s instruction cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT is_retry AND (NEW.reference <> OLD.reference OR NEW.generation <> OLD.generation
     OR NEW."previousReferences" IS DISTINCT FROM OLD."previousReferences") THEN
    RAISE EXCEPTION 'ledgerfield: a disbursement''s reference changes only when a failure is retried'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> NEW."status" AND NOT is_retry AND NOT (
       (OLD."status" = 'queued'      AND NEW."status" IN ('sending', 'paid', 'failed'))
    OR (OLD."status" = 'sending'     AND NEW."status" IN ('queued', 'sent', 'unconfirmed', 'paid', 'failed'))
    OR (OLD."status" = 'sent'        AND NEW."status" IN ('unconfirmed', 'paid', 'failed'))
    OR (OLD."status" = 'unconfirmed' AND NEW."status" IN ('sent', 'paid', 'failed'))
    OR (OLD."status" = 'failed'      AND NEW."status" = 'paid')
  ) THEN
    RAISE EXCEPTION 'ledgerfield: a disbursement cannot move from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'queued' AND NEW."conversationId" IS NOT NULL THEN
    RAISE EXCEPTION 'ledgerfield: a disbursement Daraja accepted cannot be queued again'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'paid' AND NEW."receipt" IS NULL THEN
    RAISE EXCEPTION 'ledgerfield: a paid disbursement needs its M-Pesa receipt'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'paid' AND NEW."receipt" IS DISTINCT FROM OLD."receipt" THEN
    RAISE EXCEPTION 'ledgerfield: a paid disbursement''s receipt cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
