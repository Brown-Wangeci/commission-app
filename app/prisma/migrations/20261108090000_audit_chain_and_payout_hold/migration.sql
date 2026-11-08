-- Build 4 (issues #64 to #70): the audit hash chain and its anchoring, whole
-- shilling commissions, and escrow held until a payout is confirmed.
--
--   * AuditEvent becomes append-only (DR-09).
--   * Every audit event gets a link in AuditChain, written by a deferred
--     trigger when its transaction commits: its chain position, the previous
--     link's hash, and its own hash over a canonical form that includes that
--     previous hash (NFR-11). The canonical form is specified in
--     docs/chapter5/audit-chain.md and computed identically in
--     src/lib/audit/canonical.ts. Existing events are chained here, in id order.
--   * AuditAnchor records Merkle roots over contiguous ranges of the chain.
--   * A new commission is rounded down to whole shillings; the cents rounded
--     off are recorded and returned to the client once the payout is paid.
--   * A failed payout may be retried by an administrator, with a new
--     reference; earlier references are kept so late callbacks are recognised.
--   * EscrowHoldState releases a hold only when its payout is paid.

-- CreateEnum
CREATE TYPE "AnchorStatus" AS ENUM ('pending', 'submitted', 'confirmed');

-- AlterTable
ALTER TABLE "Commission" ADD COLUMN     "roundedOffCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Disbursement" ADD COLUMN     "generation" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "previousReferences" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "AuditChain" (
    "eventId" BIGINT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "previousHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "sealedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditChain_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "AuditAnchor" (
    "id" TEXT NOT NULL,
    "fromSequence" BIGINT NOT NULL,
    "toSequence" BIGINT NOT NULL,
    "leafCount" INTEGER NOT NULL,
    "root" TEXT NOT NULL,
    "status" "AnchorStatus" NOT NULL DEFAULT 'pending',
    "chainId" INTEGER NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "searchFromBlock" BIGINT,
    "txHash" TEXT,
    "blockNumber" BIGINT,
    "chainTimestamp" TIMESTAMP(3),
    "submitter" TEXT,
    "lastError" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditAnchor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuditChain_sequence_key" ON "AuditChain"("sequence");

-- CreateIndex
CREATE UNIQUE INDEX "AuditChain_hash_key" ON "AuditChain"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "AuditAnchor_fromSequence_key" ON "AuditAnchor"("fromSequence");

-- CreateIndex
CREATE UNIQUE INDEX "AuditAnchor_toSequence_key" ON "AuditAnchor"("toSequence");

-- CreateIndex
CREATE UNIQUE INDEX "AuditAnchor_root_key" ON "AuditAnchor"("root");

-- CreateIndex
CREATE UNIQUE INDEX "AuditAnchor_txHash_key" ON "AuditAnchor"("txHash");

-- CreateIndex
CREATE INDEX "AuditAnchor_status_nextAttemptAt_idx" ON "AuditAnchor"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "AuditChain" ADD CONSTRAINT "AuditChain_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "AuditEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------- DR-09
-- An audit event is never changed or removed. A correction is a new event.
CREATE TRIGGER "AuditEvent_append_only"
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_reject_mutation();

CREATE TRIGGER "AuditChain_append_only"
  BEFORE UPDATE OR DELETE ON "AuditChain"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_reject_mutation();

-- ---------------------------------------------------------------- NFR-11
-- A text value as a JSON string, or JSON null. PostgreSQL escapes exactly as
-- JavaScript's JSON.stringify and Python's json.dumps(ensure_ascii=False) do:
-- quote, backslash, \b \f \n \r \t, other control characters as \u00xx.
CREATE FUNCTION ledgerfield_json_text(value text) RETURNS text AS $$
  SELECT CASE WHEN value IS NULL THEN 'null' ELSE to_json(value)::text END
$$ LANGUAGE sql IMMUTABLE;

-- The canonical form of an audit event at a chain position. Keys in code
-- point order, no whitespace, every value a JSON string or null, timestamps
-- as UTC with milliseconds. Specified in docs/chapter5/audit-chain.md.
CREATE FUNCTION ledgerfield_audit_canonical(e "AuditEvent", seq bigint, previous_hash text) RETURNS text AS $$
  SELECT '{"activationId":' || ledgerfield_json_text(e."activationId")
      || ',"actorId":' || ledgerfield_json_text(e."actorId")
      || ',"at":' || ledgerfield_json_text(to_char(e.at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      || ',"detail":' || ledgerfield_json_text(e.detail)
      || ',"fromState":' || ledgerfield_json_text(e."fromState"::text)
      || ',"id":' || ledgerfield_json_text(e.id::text)
      || ',"kind":' || ledgerfield_json_text(e.kind)
      || ',"previousHash":' || ledgerfield_json_text(previous_hash)
      || ',"sequence":' || ledgerfield_json_text(seq::text)
      || ',"toState":' || ledgerfield_json_text(e."toState"::text)
      || ',"version":"ledgerfield-audit-v1"}'
$$ LANGUAGE sql STABLE;

CREATE FUNCTION ledgerfield_audit_hash(e "AuditEvent", seq bigint, previous_hash text) RETURNS text AS $$
  SELECT encode(sha256(convert_to(ledgerfield_audit_canonical(e, seq, previous_hash), 'UTF8')), 'hex')
$$ LANGUAGE sql STABLE;

-- Chains one event. Runs at commit (the trigger is deferred), so the global
-- lock is held only while committing, after the transaction has taken every
-- other lock it needs: no transaction can wait on another while holding it.
-- Each statement in a volatile function sees transactions committed before
-- it, so after the lock the last link read is the true last link.
CREATE FUNCTION ledgerfield_audit_chain_seal() RETURNS trigger AS $$
DECLARE
  last_sequence bigint;
  last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ledgerfield.audit_chain'));
  SELECT "sequence", hash INTO last_sequence, last_hash
    FROM "AuditChain" ORDER BY "sequence" DESC LIMIT 1;
  IF NOT FOUND THEN
    last_sequence := 0;
    last_hash := repeat('0', 64);
  END IF;
  INSERT INTO "AuditChain" ("eventId", "sequence", "previousHash", hash, "sealedAt")
  VALUES (NEW.id, last_sequence + 1, last_hash,
          ledgerfield_audit_hash(NEW, last_sequence + 1, last_hash),
          (clock_timestamp() AT TIME ZONE 'UTC'));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Chain the events that already exist, in id order, before the trigger exists.
DO $$
DECLARE
  e "AuditEvent";
  seq bigint := 0;
  previous text := repeat('0', 64);
  current_hash text;
BEGIN
  FOR e IN SELECT * FROM "AuditEvent" ORDER BY id LOOP
    seq := seq + 1;
    current_hash := ledgerfield_audit_hash(e, seq, previous);
    INSERT INTO "AuditChain" ("eventId", "sequence", "previousHash", hash, "sealedAt")
    VALUES (e.id, seq, previous, current_hash, (clock_timestamp() AT TIME ZONE 'UTC'));
    previous := current_hash;
  END LOOP;
END $$;

CREATE CONSTRAINT TRIGGER "AuditEvent_chain"
  AFTER INSERT ON "AuditEvent"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_audit_chain_seal();

-- ---------------------------------------------------------------- anchors
-- Batches are contiguous and never overlap: each starts where the last one
-- ended, ends at a sealed event, and counts exactly its range.
CREATE FUNCTION ledgerfield_anchor_insert_guard() RETURNS trigger AS $$
DECLARE
  last_to bigint;
  chain_head bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ledgerfield.audit_anchor'));
  SELECT COALESCE(MAX("toSequence"), 0) INTO last_to FROM "AuditAnchor";
  SELECT COALESCE(MAX("sequence"), 0) INTO chain_head FROM "AuditChain";
  IF NEW."fromSequence" <> last_to + 1 OR NEW."toSequence" < NEW."fromSequence"
     OR NEW."toSequence" > chain_head
     OR NEW."leafCount" <> NEW."toSequence" - NEW."fromSequence" + 1 THEN
    RAISE EXCEPTION 'ledgerfield: an anchor batch must continue the chain from sequence %', last_to + 1
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.root !~ '^[0-9a-f]{64}$' OR NEW.status <> 'pending' OR NEW."txHash" IS NOT NULL THEN
    RAISE EXCEPTION 'ledgerfield: an anchor batch starts pending, with a 64-digit root'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditAnchor_contiguous"
  BEFORE INSERT ON "AuditAnchor"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_anchor_insert_guard();

-- What a batch covers never changes, and a confirmed anchor is final.
CREATE FUNCTION ledgerfield_anchor_update_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."fromSequence" <> OLD."fromSequence" OR NEW."toSequence" <> OLD."toSequence"
     OR NEW."leafCount" <> OLD."leafCount" OR NEW.root <> OLD.root
     OR NEW."chainId" <> OLD."chainId" OR NEW."contractAddress" <> OLD."contractAddress" THEN
    RAISE EXCEPTION 'ledgerfield: an anchor batch''s range and root cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'confirmed' AND (NEW.status <> 'confirmed'
     OR NEW."txHash" IS DISTINCT FROM OLD."txHash" OR NEW."blockNumber" IS DISTINCT FROM OLD."blockNumber") THEN
    RAISE EXCEPTION 'ledgerfield: a confirmed anchor cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'confirmed' AND (NEW."txHash" IS NULL OR NEW."blockNumber" IS NULL) THEN
    RAISE EXCEPTION 'ledgerfield: a confirmed anchor needs its transaction and block'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditAnchor_guard"
  BEFORE UPDATE ON "AuditAnchor"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_anchor_update_guard();

CREATE TRIGGER "AuditAnchor_no_delete"
  BEFORE DELETE ON "AuditAnchor"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_reject_mutation();

-- ---------------------------------------------------------------- commission
-- The amount paid plus the cents rounded off is the calculated commission.
-- Rows written before this build have nothing rounded off.
ALTER TABLE "Commission" DROP CONSTRAINT "Commission_amount_is_sum";
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_amount_plus_rounding_is_sum"
  CHECK ("amountCents"::bigint + "roundedOffCents" = "rateComponentCents"::bigint + "flatCommissionCents"
         AND "roundedOffCents" BETWEEN 0 AND 99);

-- A commission is recorded only for an approved activation, on that
-- activation's job, with that job's structure, and now in whole shillings,
-- with exactly the odd cents rounded off.
CREATE OR REPLACE FUNCTION ledgerfield_commission_guard() RETURNS trigger AS $$
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
  IF NEW."amountCents" % 100 <> 0
     OR NEW."roundedOffCents" <> (NEW."rateComponentCents"::bigint + NEW."flatCommissionCents") % 100 THEN
    RAISE EXCEPTION 'ledgerfield: a commission is paid in whole shillings, with only the odd cents rounded off'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- payouts
-- As before (NFR-04): the instruction is fixed, and once Daraja may hold it
-- the row cannot become sendable again. One exception, an administrator
-- retry: a failed row may become queued under a new reference, one generation
-- on, with the old reference kept and nothing of the old result carried over.
CREATE OR REPLACE FUNCTION ledgerfield_disbursement_guard() RETURNS trigger AS $$
DECLARE
  is_retry boolean := OLD.status = 'failed' AND NEW.status = 'queued'
    AND NEW.generation = OLD.generation + 1
    AND NEW.reference <> OLD.reference
    AND NEW."previousReferences" = array_append(OLD."previousReferences", OLD.reference)
    AND NEW."conversationId" IS NULL AND NEW.receipt IS NULL;
BEGIN
  IF NEW."activationId" <> OLD."activationId" OR NEW."commissionId" <> OLD."commissionId"
     OR NEW."authorisationId" <> OLD."authorisationId"
     OR NEW."amountCents" <> OLD."amountCents" OR NEW."payoutMsisdn" <> OLD."payoutMsisdn" THEN
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

-- The no-op authoriser was removed in Build 3. Approvals it recorded before
-- then stay released (below); no new one can be written, so nothing written
-- from now on can release escrow without a paid disbursement.
CREATE FUNCTION ledgerfield_no_new_noop_payout() RETURNS trigger AS $$
BEGIN
  IF NEW.provider = 'noop' THEN
    RAISE EXCEPTION 'ledgerfield: the no-op payout authoriser no longer exists'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Named to sort first: PostgreSQL runs triggers for one event in name order.
CREATE TRIGGER "PayoutAuthorisation_0_no_new_noop"
  BEFORE INSERT ON "PayoutAuthorisation"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_no_new_noop_payout();

-- ---------------------------------------------------------------- escrow
-- A hold is released only when its payout is paid. Approved but not yet paid,
-- or paid and then failed, it stays held. Approvals from before M-Pesa
-- payouts existed (no-op authorisation, no disbursement) stay released, as
-- they were. Once released, the whole-shilling commission is what left, and
-- the cents rounded off are back with the client.
DROP VIEW "EscrowHoldState";
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
    WHEN a.state = 'approved' AND (d.status = 'paid' OR (d.id IS NULL AND pa.provider = 'noop')) THEN 'released'
    WHEN a.state IN ('refused', 'withdrawn') THEN 'returned'
    ELSE 'held'
  END                AS "state",
  d.status           AS "disbursementStatus",
  CASE
    WHEN a.state = 'approved' AND (d.status = 'paid' OR (d.id IS NULL AND pa.provider = 'noop'))
    THEN COALESCE(c."amountCents", h."amountCents")
  END                AS "paidCents",
  CASE
    WHEN a.state = 'approved' AND (d.status = 'paid' OR (d.id IS NULL AND pa.provider = 'noop'))
    THEN h."amountCents" - COALESCE(c."amountCents", h."amountCents")
    ELSE 0
  END                AS "remainderCents"
FROM "EscrowHold" h
JOIN "Assignment" asg ON asg.id = h."assignmentId"
LEFT JOIN "Activation" a ON a."assignmentId" = h."assignmentId"
LEFT JOIN "Commission" c ON c."activationId" = a.id
LEFT JOIN "PayoutAuthorisation" pa ON pa."activationId" = a.id
LEFT JOIN "Disbursement" d ON d."activationId" = a.id;
