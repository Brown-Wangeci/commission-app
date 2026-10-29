-- Issues #40 to #43: money in integer cents, a per-job commission structure,
-- escrow locked at publication and owned by the client, one commission record
-- per approved activation, and the full feature vector on each scoring
-- decision.
--
-- Existing data converts in place:
--   - every amount is multiplied by 100 into a column named ...Cents;
--   - a job's flat payout per activation becomes a commission structure that
--     reproduces it exactly: the old rate as basis points, applied to a
--     submission value chosen so that the floored rate component equals the
--     old payout, and no flat amount;
--   - deposits move from the job to the client business that owns it;
--   - each job locks the smaller of its maximum liability and what was
--     deposited for it, so no client starts with a negative balance and no
--     job can commit more than it was funded for;
--   - every approved activation gets the commission record it would have had,
--     and its payout authorisation is linked to it;
--   - the customer top-up (a Float of shillings) becomes integer cents.
-- Each conversion is checked below; the migration stops with an error rather
-- than store a value that is wrong or does not fit in an INTEGER.

-- 0. Refuse anything that would not fit in an INTEGER of cents.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Job" WHERE "slots"::bigint * "payoutPerActivationKsh" * 100 > 2147483647) THEN
    RAISE EXCEPTION 'ledgerfield migration: a job''s maximum liability does not fit in integer cents';
  END IF;
  IF EXISTS (SELECT 1 FROM "EscrowDeposit" WHERE "amountKsh"::bigint * 100 > 2147483647) THEN
    RAISE EXCEPTION 'ledgerfield migration: a deposit does not fit in integer cents';
  END IF;
  IF EXISTS (SELECT 1 FROM "CustomerActivityDay" WHERE round("topupAmountKsh"::numeric * 100) > 2147483647) THEN
    RAISE EXCEPTION 'ledgerfield migration: a customer top-up does not fit in integer cents';
  END IF;
END;
$$;

-- 1. The escrow view reads EscrowHold."amountKsh"; it is recreated at the end.
DROP VIEW "EscrowHoldState";

-- 2. Job: commission structure, escrow lock and close time.
ALTER TABLE "Job"
  ADD COLUMN "submissionValueCents" INTEGER,
  ADD COLUMN "commissionRateBps" INTEGER,
  ADD COLUMN "flatCommissionCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "escrowLockedCents" INTEGER,
  ADD COLUMN "closedAt" TIMESTAMP(3);

UPDATE "Job"
SET "commissionRateBps" = GREATEST(1, LEAST(10000, round("commissionRate"::numeric * 10000)))::integer;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Job"
    WHERE ("payoutPerActivationKsh"::bigint * 1000000 + "commissionRateBps" - 1) / "commissionRateBps" > 2147483647
  ) THEN
    RAISE EXCEPTION 'ledgerfield migration: a job''s implied submission value does not fit in integer cents';
  END IF;
END;
$$;

-- The smallest value whose floored rate component is the old payout:
-- ceil(payout cents x 10000 / bps), in integer arithmetic.
UPDATE "Job"
SET "submissionValueCents" =
  (("payoutPerActivationKsh"::bigint * 1000000 + "commissionRateBps" - 1) / "commissionRateBps")::integer;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Job"
    WHERE ("submissionValueCents"::bigint * "commissionRateBps") / 10000 <> "payoutPerActivationKsh"::bigint * 100
  ) THEN
    RAISE EXCEPTION 'ledgerfield migration: a converted commission structure does not reproduce the old payout';
  END IF;
END;
$$;

UPDATE "Job" j
SET "escrowLockedCents" = LEAST(
  j."slots"::bigint * j."payoutPerActivationKsh" * 100,
  COALESCE((SELECT sum(d."amountKsh") FROM "EscrowDeposit" d WHERE d."jobId" = j.id), 0) * 100
)::integer;

-- No action closed a job before this migration; any job already marked
-- closed is recorded as closed now.
UPDATE "Job" SET "closedAt" = CURRENT_TIMESTAMP WHERE "status" = 'closed';

ALTER TABLE "Job"
  ALTER COLUMN "submissionValueCents" SET NOT NULL,
  ALTER COLUMN "commissionRateBps" SET NOT NULL,
  ALTER COLUMN "escrowLockedCents" SET NOT NULL;

-- 3. Deposits belong to the client business, in cents.
ALTER TABLE "EscrowDeposit" ADD COLUMN "clientId" TEXT, ADD COLUMN "amountCents" INTEGER;

UPDATE "EscrowDeposit" d
SET "clientId" = j."clientId", "amountCents" = d."amountKsh" * 100
FROM "Job" j
WHERE j.id = d."jobId";

ALTER TABLE "EscrowDeposit"
  ALTER COLUMN "clientId" SET NOT NULL,
  ALTER COLUMN "amountCents" SET NOT NULL,
  DROP CONSTRAINT "EscrowDeposit_jobId_fkey",
  DROP CONSTRAINT "EscrowDeposit_amount_positive";
ALTER TABLE "EscrowDeposit" DROP COLUMN "jobId", DROP COLUMN "amountKsh";
ALTER TABLE "EscrowDeposit" ADD CONSTRAINT "EscrowDeposit_amount_positive" CHECK ("amountCents" > 0);
CREATE INDEX "EscrowDeposit_clientId_idx" ON "EscrowDeposit"("clientId");
ALTER TABLE "EscrowDeposit" ADD CONSTRAINT "EscrowDeposit_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "ClientBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Holds in cents.
ALTER TABLE "EscrowHold" ADD COLUMN "amountCents" INTEGER;
UPDATE "EscrowHold" SET "amountCents" = "amountKsh" * 100;
ALTER TABLE "EscrowHold"
  ALTER COLUMN "amountCents" SET NOT NULL,
  DROP CONSTRAINT "EscrowHold_amount_positive";
ALTER TABLE "EscrowHold" DROP COLUMN "amountKsh";
ALTER TABLE "EscrowHold" ADD CONSTRAINT "EscrowHold_amount_positive" CHECK ("amountCents" > 0);

-- 5. Commission records.
CREATE TABLE "Commission" (
    "id" TEXT NOT NULL,
    "activationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "submissionValueCents" INTEGER NOT NULL,
    "commissionRateBps" INTEGER NOT NULL,
    "rateComponentCents" INTEGER NOT NULL,
    "flatCommissionCents" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "approvedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Commission_activationId_key" ON "Commission"("activationId");
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_activationId_fkey"
  FOREIGN KEY ("activationId") REFERENCES "Activation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The stored amount must follow from the stored structure: floor of value x
-- rate / 10000 (integer division of non-negative integers is the floor), plus
-- the flat amount.
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_rate_range" CHECK ("commissionRateBps" BETWEEN 1 AND 10000);
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_structure_nonnegative"
  CHECK ("submissionValueCents" > 0 AND "flatCommissionCents" >= 0);
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_rate_component_is_floor"
  CHECK ("rateComponentCents"::bigint = ("submissionValueCents"::bigint * "commissionRateBps") / 10000);
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_amount_is_sum"
  CHECK ("amountCents"::bigint = "rateComponentCents"::bigint + "flatCommissionCents");
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_amount_positive" CHECK ("amountCents" > 0);

-- A commission is recorded only for an approved activation, on that
-- activation's job, with that job's structure.
CREATE FUNCTION ledgerfield_commission_guard() RETURNS trigger AS $$
DECLARE
  activation_state "ActivationState";
  activation_job text;
  job_row "Job"%ROWTYPE;
BEGIN
  SELECT state, "jobId" INTO activation_state, activation_job FROM "Activation" WHERE id = NEW."activationId";
  IF activation_state IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'ledgerfield: a commission can only be recorded for an approved activation'
      USING ERRCODE = 'check_violation';
  END IF;
  IF activation_job IS DISTINCT FROM NEW."jobId" THEN
    RAISE EXCEPTION 'ledgerfield: a commission must be recorded on its activation''s job'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO job_row FROM "Job" WHERE id = NEW."jobId";
  IF (job_row."submissionValueCents", job_row."commissionRateBps", job_row."flatCommissionCents")
     IS DISTINCT FROM (NEW."submissionValueCents", NEW."commissionRateBps", NEW."flatCommissionCents") THEN
    RAISE EXCEPTION 'ledgerfield: a commission must carry its job''s commission structure'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Commission_guard"
  BEFORE INSERT ON "Commission"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_commission_guard();

CREATE TRIGGER "Commission_append_only"
  BEFORE UPDATE OR DELETE ON "Commission"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_reject_mutation();

-- Backfill: the commission each approved activation would have had, at the
-- time its payout was authorised.
INSERT INTO "Commission" (
  "id", "activationId", "jobId", "submissionValueCents", "commissionRateBps",
  "rateComponentCents", "flatCommissionCents", "amountCents", "computedAt", "approvedById"
)
SELECT
  'cm' || replace(gen_random_uuid()::text, '-', ''),
  a.id,
  a."jobId",
  j."submissionValueCents",
  j."commissionRateBps",
  ((j."submissionValueCents"::bigint * j."commissionRateBps") / 10000)::integer,
  j."flatCommissionCents",
  ((j."submissionValueCents"::bigint * j."commissionRateBps") / 10000 + j."flatCommissionCents")::integer,
  COALESCE(p."authorisedAt", a."updatedAt"),
  p."authorisedById"
FROM "Activation" a
JOIN "Job" j ON j.id = a."jobId"
LEFT JOIN "PayoutAuthorisation" p ON p."activationId" = a.id
WHERE a.state = 'approved';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Commission" c
    JOIN "Activation" a ON a.id = c."activationId"
    JOIN "EscrowHold" h ON h."assignmentId" = a."assignmentId"
    WHERE h."amountCents" <> c."amountCents"
  ) THEN
    RAISE EXCEPTION 'ledgerfield migration: a backfilled commission differs from its escrow hold';
  END IF;
END;
$$;

-- 6. Payout authorisations pay the commission, in cents.
ALTER TABLE "PayoutAuthorisation" ADD COLUMN "commissionId" TEXT, ADD COLUMN "amountCents" INTEGER;

UPDATE "PayoutAuthorisation" p
SET "commissionId" = c.id, "amountCents" = p."amountKsh" * 100
FROM "Commission" c
WHERE c."activationId" = p."activationId";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "PayoutAuthorisation" p
    LEFT JOIN "Commission" c ON c.id = p."commissionId"
    WHERE c.id IS NULL OR p."amountCents" <> c."amountCents"
  ) THEN
    RAISE EXCEPTION 'ledgerfield migration: a payout authorisation does not match a commission';
  END IF;
END;
$$;

ALTER TABLE "PayoutAuthorisation"
  ALTER COLUMN "commissionId" SET NOT NULL,
  ALTER COLUMN "amountCents" SET NOT NULL,
  DROP CONSTRAINT "PayoutAuthorisation_amount_positive";
ALTER TABLE "PayoutAuthorisation" DROP COLUMN "amountKsh";
ALTER TABLE "PayoutAuthorisation" ADD CONSTRAINT "PayoutAuthorisation_amount_positive" CHECK ("amountCents" > 0);
CREATE UNIQUE INDEX "PayoutAuthorisation_commissionId_key" ON "PayoutAuthorisation"("commissionId");
ALTER TABLE "PayoutAuthorisation" ADD CONSTRAINT "PayoutAuthorisation_commissionId_fkey"
  FOREIGN KEY ("commissionId") REFERENCES "Commission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An authorisation pays exactly its own activation's commission.
CREATE FUNCTION ledgerfield_payout_guard() RETURNS trigger AS $$
DECLARE
  commission_row "Commission"%ROWTYPE;
BEGIN
  SELECT * INTO commission_row FROM "Commission" WHERE id = NEW."commissionId";
  IF commission_row.id IS NULL
     OR commission_row."activationId" <> NEW."activationId"
     OR commission_row."amountCents" <> NEW."amountCents" THEN
    RAISE EXCEPTION 'ledgerfield: a payout authorisation must pay exactly its activation''s commission'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayoutAuthorisation_matches_commission"
  BEFORE INSERT OR UPDATE ON "PayoutAuthorisation"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_payout_guard();

-- 7. Customer top-up in cents.
ALTER TABLE "CustomerActivityDay" ADD COLUMN "topupCents" INTEGER;
UPDATE "CustomerActivityDay" SET "topupCents" = round("topupAmountKsh"::numeric * 100)::integer;
ALTER TABLE "CustomerActivityDay"
  ALTER COLUMN "topupCents" SET NOT NULL,
  DROP CONSTRAINT "CustomerActivityDay_counts_nonnegative";
ALTER TABLE "CustomerActivityDay" DROP COLUMN "topupAmountKsh";
ALTER TABLE "CustomerActivityDay" ADD CONSTRAINT "CustomerActivityDay_counts_nonnegative"
  CHECK ("transactionCount" >= 0 AND "topupCents" >= 0 AND "usageMinutes" >= 0);

-- 8. Job: drop the old money columns and constrain the new ones.
ALTER TABLE "Job"
  DROP CONSTRAINT "Job_payout_positive",
  DROP CONSTRAINT "Job_commission_rate_range";
ALTER TABLE "Job" DROP COLUMN "payoutPerActivationKsh", DROP COLUMN "commissionRate";
ALTER TABLE "Job" ADD CONSTRAINT "Job_submission_value_positive" CHECK ("submissionValueCents" > 0);
ALTER TABLE "Job" ADD CONSTRAINT "Job_commission_rate_range" CHECK ("commissionRateBps" BETWEEN 1 AND 10000);
ALTER TABLE "Job" ADD CONSTRAINT "Job_flat_commission_nonnegative" CHECK ("flatCommissionCents" >= 0);
ALTER TABLE "Job" ADD CONSTRAINT "Job_commission_positive"
  CHECK (("submissionValueCents"::bigint * "commissionRateBps") / 10000 + "flatCommissionCents" > 0);
ALTER TABLE "Job" ADD CONSTRAINT "Job_escrow_lock_range"
  CHECK (
    "escrowLockedCents" >= 0
    AND "escrowLockedCents"::bigint <= "slots"::bigint
      * (("submissionValueCents"::bigint * "commissionRateBps") / 10000 + "flatCommissionCents")
  );
ALTER TABLE "Job" ADD CONSTRAINT "Job_closed_at_matches_status"
  CHECK (("status" = 'closed') = ("closedAt" IS NOT NULL));

-- A published job's terms are fixed, and a closed job stays closed, so the
-- escrow derived from them never changes underneath a commission or a lock.
CREATE FUNCTION ledgerfield_job_terms_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW."clientId", NEW."submissionValueCents", NEW."commissionRateBps", NEW."flatCommissionCents", NEW."slots", NEW."escrowLockedCents")
     IS DISTINCT FROM
     (OLD."clientId", OLD."submissionValueCents", OLD."commissionRateBps", OLD."flatCommissionCents", OLD."slots", OLD."escrowLockedCents") THEN
    RAISE EXCEPTION 'ledgerfield: a published job''s commission structure, slots and escrow lock cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'closed' AND (NEW."status" <> 'closed' OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt") THEN
    RAISE EXCEPTION 'ledgerfield: a closed job cannot be reopened'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Job_published_terms_fixed"
  BEFORE UPDATE ON "Job"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_job_terms_guard();

-- 9. The full feature vector on each scoring decision (issue #43). Adding a
-- column fires no row trigger, so the append-only rule is unaffected.
ALTER TABLE "ScoringDecision" ADD COLUMN "featureVector" JSONB;

-- 10. The escrow view, as before, in cents.
CREATE VIEW "EscrowHoldState" AS
SELECT
  h.id               AS "holdId",
  h."assignmentId"   AS "assignmentId",
  asg."jobId"        AS "jobId",
  asg."agentId"      AS "agentId",
  h."amountCents"    AS "amountCents",
  h."createdAt"      AS "createdAt",
  a.id               AS "activationId",
  a.state            AS "activationState",
  CASE
    WHEN a.id IS NULL THEN 'reserved'
    WHEN a.state = 'approved' THEN 'released'
    WHEN a.state IN ('refused', 'withdrawn') THEN 'returned'
    ELSE 'held'
  END                AS "state"
FROM "EscrowHold" h
JOIN "Assignment" asg ON asg.id = h."assignmentId"
LEFT JOIN "Activation" a ON a."assignmentId" = h."assignmentId";
