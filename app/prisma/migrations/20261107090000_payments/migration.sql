-- Issues #55 to #58: M-Pesa funding and disbursement.
--
-- Escrow is now credited only from a confirmed funding attempt, and every
-- approved payout gets one B2C instruction. The rules that protect money live
-- here, in the database, so no code path can step around them:
--
--   * a new deposit must point at a confirmed attempt for the same client and
--     amount, and an attempt can credit once (unique);
--   * one disbursement per activation, commission and authorisation (unique),
--     and it must carry exactly what was authorised;
--   * once Daraja may hold an instruction the row can never become sendable
--     again, so a retry cannot turn into a second payment.
--
-- Existing data: no row is converted. Deposits made before this build keep a
-- null fundingAttemptId. Payouts authorised through the old no-op get no
-- disbursement: queueing them here would move real money for approvals that
-- were recorded on the understanding that nothing would be paid.

-- CreateEnum
CREATE TYPE "FundingStatus" AS ENUM ('queued', 'sending', 'pending', 'confirmed', 'failed');

-- CreateEnum
CREATE TYPE "DisbursementStatus" AS ENUM ('queued', 'sending', 'sent', 'unconfirmed', 'paid', 'failed');

-- CreateEnum
CREATE TYPE "PaymentCallbackOutcome" AS ENUM ('applied', 'duplicate', 'unknown_reference', 'conflict', 'ignored');

-- AlterTable
ALTER TABLE "EscrowDeposit" ADD COLUMN     "fundingAttemptId" TEXT;

-- CreateTable
CREATE TABLE "FundingAttempt" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "payerMsisdn" TEXT NOT NULL,
    "status" "FundingStatus" NOT NULL DEFAULT 'queued',
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "queryCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "merchantRequestId" TEXT,
    "checkoutRequestId" TEXT,
    "receipt" TEXT,
    "resultCode" TEXT,
    "failureReason" TEXT,
    "lastError" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Disbursement" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "activationId" TEXT NOT NULL,
    "commissionId" TEXT NOT NULL,
    "authorisationId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "payoutMsisdn" TEXT NOT NULL,
    "status" "DisbursementStatus" NOT NULL DEFAULT 'queued',
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "queryCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "conversationId" TEXT,
    "receipt" TEXT,
    "resultCode" TEXT,
    "failureReason" TEXT,
    "lastError" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Disbursement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentCallback" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "outcome" "PaymentCallbackOutcome" NOT NULL,
    "resultCode" TEXT,
    "note" TEXT,
    "summary" JSONB NOT NULL,
    "deliveries" INTEGER NOT NULL DEFAULT 1,
    "firstReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentCallback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FundingAttempt_reference_key" ON "FundingAttempt"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "FundingAttempt_checkoutRequestId_key" ON "FundingAttempt"("checkoutRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "FundingAttempt_receipt_key" ON "FundingAttempt"("receipt");

-- CreateIndex
CREATE INDEX "FundingAttempt_status_nextAttemptAt_idx" ON "FundingAttempt"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "FundingAttempt_clientId_createdAt_idx" ON "FundingAttempt"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Disbursement_reference_key" ON "Disbursement"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Disbursement_activationId_key" ON "Disbursement"("activationId");

-- CreateIndex
CREATE UNIQUE INDEX "Disbursement_commissionId_key" ON "Disbursement"("commissionId");

-- CreateIndex
CREATE UNIQUE INDEX "Disbursement_authorisationId_key" ON "Disbursement"("authorisationId");

-- CreateIndex
CREATE UNIQUE INDEX "Disbursement_conversationId_key" ON "Disbursement"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "Disbursement_receipt_key" ON "Disbursement"("receipt");

-- CreateIndex
CREATE INDEX "Disbursement_status_nextAttemptAt_idx" ON "Disbursement"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentCallback_dedupeKey_key" ON "PaymentCallback"("dedupeKey");

-- CreateIndex
CREATE INDEX "PaymentCallback_outcome_lastReceivedAt_idx" ON "PaymentCallback"("outcome", "lastReceivedAt");

-- CreateIndex
CREATE INDEX "PaymentCallback_reference_idx" ON "PaymentCallback"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowDeposit_fundingAttemptId_key" ON "EscrowDeposit"("fundingAttemptId");

-- AddForeignKey
ALTER TABLE "EscrowDeposit" ADD CONSTRAINT "EscrowDeposit_fundingAttemptId_fkey" FOREIGN KEY ("fundingAttemptId") REFERENCES "FundingAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundingAttempt" ADD CONSTRAINT "FundingAttempt_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ClientBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Disbursement" ADD CONSTRAINT "Disbursement_activationId_fkey" FOREIGN KEY ("activationId") REFERENCES "Activation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Disbursement" ADD CONSTRAINT "Disbursement_commissionId_fkey" FOREIGN KEY ("commissionId") REFERENCES "Commission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Disbursement" ADD CONSTRAINT "Disbursement_authorisationId_fkey" FOREIGN KEY ("authorisationId") REFERENCES "PayoutAuthorisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A deposit exists only because a verified callback confirmed the attempt.
CREATE FUNCTION ledgerfield_deposit_guard() RETURNS trigger AS $$
DECLARE
  attempt RECORD;
BEGIN
  SELECT "status", "clientId", "amountCents" INTO attempt
    FROM "FundingAttempt" WHERE "id" = NEW."fundingAttemptId";
  IF NOT FOUND OR attempt."status" <> 'confirmed' THEN
    RAISE EXCEPTION 'ledgerfield: a deposit needs a confirmed funding attempt'
      USING ERRCODE = 'check_violation';
  END IF;
  IF attempt."clientId" <> NEW."clientId" OR attempt."amountCents" <> NEW."amountCents" THEN
    RAISE EXCEPTION 'ledgerfield: a deposit must credit exactly its funding attempt'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EscrowDeposit_requires_confirmed_funding"
  BEFORE INSERT ON "EscrowDeposit"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_deposit_guard();

-- A funding attempt's instruction is fixed and its status only moves forward.
CREATE FUNCTION ledgerfield_funding_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."reference" <> OLD."reference" OR NEW."clientId" <> OLD."clientId"
     OR NEW."amountCents" <> OLD."amountCents" OR NEW."payerMsisdn" <> OLD."payerMsisdn" THEN
    RAISE EXCEPTION 'ledgerfield: a funding attempt''s instruction cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> NEW."status" AND NOT (
       (OLD."status" = 'queued'  AND NEW."status" IN ('sending', 'confirmed', 'failed'))
    OR (OLD."status" = 'sending' AND NEW."status" IN ('queued', 'pending', 'confirmed', 'failed'))
    OR (OLD."status" = 'pending' AND NEW."status" IN ('confirmed', 'failed'))
    OR (OLD."status" = 'failed'  AND NEW."status" = 'confirmed')
  ) THEN
    RAISE EXCEPTION 'ledgerfield: a funding attempt cannot move from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'confirmed' AND NEW."receipt" IS NULL THEN
    RAISE EXCEPTION 'ledgerfield: a confirmed funding attempt needs its M-Pesa receipt'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FundingAttempt_guard"
  BEFORE UPDATE ON "FundingAttempt"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_funding_guard();

-- A disbursement carries exactly what was authorised.
CREATE FUNCTION ledgerfield_disbursement_insert_guard() RETURNS trigger AS $$
DECLARE
  authorised RECORD;
BEGIN
  SELECT "activationId", "commissionId", "amountCents", "payoutMsisdn" INTO authorised
    FROM "PayoutAuthorisation" WHERE "id" = NEW."authorisationId";
  IF NOT FOUND OR authorised."activationId" <> NEW."activationId"
     OR authorised."commissionId" <> NEW."commissionId"
     OR authorised."amountCents" <> NEW."amountCents"
     OR authorised."payoutMsisdn" <> NEW."payoutMsisdn" THEN
    RAISE EXCEPTION 'ledgerfield: a disbursement must pay exactly its authorisation'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" NOT IN ('queued', 'failed') OR NEW."sendCount" <> 0 THEN
    RAISE EXCEPTION 'ledgerfield: a disbursement starts unsent'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Disbursement_matches_authorisation"
  BEFORE INSERT ON "Disbursement"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_disbursement_insert_guard();

-- NFR-04. The instruction is fixed, and once Daraja may hold it (sent,
-- unconfirmed) or has answered it (paid, failed) the row cannot become queued
-- or sending again. Back to queued is allowed only from sending, and only
-- while no ConversationID exists: that is a send Daraja never accepted.
CREATE FUNCTION ledgerfield_disbursement_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."reference" <> OLD."reference" OR NEW."activationId" <> OLD."activationId"
     OR NEW."commissionId" <> OLD."commissionId" OR NEW."authorisationId" <> OLD."authorisationId"
     OR NEW."amountCents" <> OLD."amountCents" OR NEW."payoutMsisdn" <> OLD."payoutMsisdn" THEN
    RAISE EXCEPTION 'ledgerfield: a disbursement''s instruction cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> NEW."status" AND NOT (
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

CREATE TRIGGER "Disbursement_guard"
  BEFORE UPDATE ON "Disbursement"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_disbursement_guard();

-- Payment records are never deleted. Tests and the seed clear with TRUNCATE.
CREATE TRIGGER "FundingAttempt_no_delete"
  BEFORE DELETE ON "FundingAttempt"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_reject_mutation();

CREATE TRIGGER "Disbursement_no_delete"
  BEFORE DELETE ON "Disbursement"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_reject_mutation();

CREATE TRIGGER "PaymentCallback_no_delete"
  BEFORE DELETE ON "PaymentCallback"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_reject_mutation();
