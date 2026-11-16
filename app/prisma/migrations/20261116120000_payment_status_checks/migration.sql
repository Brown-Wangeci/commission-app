-- Status checks to Daraja: a record of every answer, and slow reconciliation
-- after the app has given up waiting (defects 10 to 12).
--
-- Adds counters and a reconciliation deadline to the two payment queues, and an
-- append-only table with one row per status check. No existing row changes:
-- every new column is empty or zero, so nothing is reconciled until the app
-- itself sets a deadline on a row.

-- AlterTable
ALTER TABLE "FundingAttempt" ADD COLUMN "noAnswerCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "reconcileUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Disbursement" ADD COLUMN "noAnswerCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "reconcileUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PaymentStatusCheck" (
    "id" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "fundingAttemptId" TEXT,
    "disbursementId" TEXT,
    "purpose" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "countedAsCheck" BOOLEAN NOT NULL,
    "httpStatus" INTEGER,
    "darajaCode" TEXT,
    "detail" TEXT,
    "retryAfterSeconds" INTEGER,
    "nextCheckAt" TIMESTAMP(3),

    CONSTRAINT "PaymentStatusCheck_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentStatusCheck_one_subject" CHECK (("fundingAttemptId" IS NULL) <> ("disbursementId" IS NULL))
);

-- CreateIndex
CREATE INDEX "PaymentStatusCheck_fundingAttemptId_checkedAt_idx" ON "PaymentStatusCheck"("fundingAttemptId", "checkedAt");

-- CreateIndex
CREATE INDEX "PaymentStatusCheck_disbursementId_checkedAt_idx" ON "PaymentStatusCheck"("disbursementId", "checkedAt");

-- AddForeignKey
ALTER TABLE "PaymentStatusCheck" ADD CONSTRAINT "PaymentStatusCheck_fundingAttemptId_fkey" FOREIGN KEY ("fundingAttemptId") REFERENCES "FundingAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentStatusCheck" ADD CONSTRAINT "PaymentStatusCheck_disbursementId_fkey" FOREIGN KEY ("disbursementId") REFERENCES "Disbursement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What Daraja answered is a record, never edited or removed. Tests and the
-- seed clear it with TRUNCATE, which fires no row trigger.
CREATE TRIGGER "PaymentStatusCheck_append_only"
  BEFORE UPDATE OR DELETE ON "PaymentStatusCheck"
  FOR EACH ROW EXECUTE FUNCTION ledgerfield_reject_mutation();
