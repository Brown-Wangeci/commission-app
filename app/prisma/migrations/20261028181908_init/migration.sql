-- CreateEnum
CREATE TYPE "Role" AS ENUM ('agent', 'admin', 'client');

-- CreateEnum
CREATE TYPE "ActivationState" AS ENUM ('submitted', 'scored_t0', 'held', 'scored_t7', 'in_review', 'awaiting_evidence', 'approved', 'refused', 'disputed', 'withdrawn');

-- CreateEnum
CREATE TYPE "ScoringMode" AS ENUM ('t0', 't7');

-- CreateEnum
CREATE TYPE "Band" AS ENUM ('auto_release', 'review', 'reject');

-- CreateEnum
CREATE TYPE "ReasonDirection" AS ENUM ('raises', 'lowers');

-- CreateEnum
CREATE TYPE "ActivationMethod" AS ENUM ('qr_scan', 'manual_entry');

-- CreateEnum
CREATE TYPE "NetworkType" AS ENUM ('cellular', 'wifi');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('photo', 'proof');

-- CreateEnum
CREATE TYPE "LocationSource" AS ENUM ('exif', 'device', 'none');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "ReviewOpenReason" AS ENUM ('band_review', 't0_reject_escalation', 'could_not_be_scored', 'evidence_returned', 'dispute');

-- CreateEnum
CREATE TYPE "ReviewAction" AS ENUM ('approved', 'refused', 'evidence_requested', 'withdrawn_by_agent');

-- CreateEnum
CREATE TYPE "EvidenceRequestStatus" AS ENUM ('open', 'answered', 'withdrawn');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('open', 'contested', 'upheld', 'overturned');

-- CreateEnum
CREATE TYPE "ScoringJobStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ScoringAttemptOutcome" AS ENUM ('succeeded', 'failed');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientBusiness" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientBusiness_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "payoutMsisdn" TEXT NOT NULL,
    "registeredAt" TIMESTAMP(3) NOT NULL,
    "homeLat" DOUBLE PRECISION NOT NULL,
    "homeLon" DOUBLE PRECISION NOT NULL,
    "homeAreaName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "areaName" TEXT NOT NULL,
    "areaLat" DOUBLE PRECISION NOT NULL,
    "areaLon" DOUBLE PRECISION NOT NULL,
    "areaRadiusM" INTEGER NOT NULL,
    "payoutPerActivationKsh" INTEGER NOT NULL,
    "commissionRate" DOUBLE PRECISION NOT NULL,
    "slots" INTEGER NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscrowDeposit" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "amountKsh" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscrowDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscrowHold" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "amountKsh" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscrowHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activation" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "state" "ActivationState" NOT NULL DEFAULT 'submitted',
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "heldAt" TIMESTAMP(3),
    "holdClosesAt" TIMESTAMP(3),
    "unscoredStage" "ScoringMode",
    "deviceId" TEXT NOT NULL,
    "deviceOs" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "ipRegion" TEXT NOT NULL,
    "networkType" "NetworkType" NOT NULL,
    "gpsLat" DOUBLE PRECISION NOT NULL,
    "gpsLon" DOUBLE PRECISION NOT NULL,
    "gpsAccuracyM" DOUBLE PRECISION,
    "customerMsisdnHash" TEXT NOT NULL,
    "customerMsisdnMasked" TEXT NOT NULL,
    "simRegisteredAt" TIMESTAMP(3) NOT NULL,
    "activationMethod" "ActivationMethod" NOT NULL,
    "proofHash" TEXT,
    "agentNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Activation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceItem" (
    "id" TEXT NOT NULL,
    "activationId" TEXT NOT NULL,
    "evidenceRequestId" TEXT,
    "kind" "EvidenceKind" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3),
    "gpsLat" DOUBLE PRECISION,
    "gpsLon" DOUBLE PRECISION,
    "gpsAccuracyM" DOUBLE PRECISION,
    "locationSource" "LocationSource" NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoringDecision" (
    "id" TEXT NOT NULL,
    "activationId" TEXT NOT NULL,
    "mode" "ScoringMode" NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "featureSet" TEXT NOT NULL,
    "rawScore" DOUBLE PRECISION NOT NULL,
    "probability" DOUBLE PRECISION NOT NULL,
    "band" "Band" NOT NULL,
    "releaseThreshold" DOUBLE PRECISION NOT NULL,
    "rejectThreshold" DOUBLE PRECISION NOT NULL,
    "scoredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trigger" TEXT NOT NULL,

    CONSTRAINT "ScoringDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoringReason" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "feature" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "contribution" DOUBLE PRECISION NOT NULL,
    "direction" "ReasonDirection" NOT NULL,
    "isAgentLevel" BOOLEAN NOT NULL,

    CONSTRAINT "ScoringReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoringAttempt" (
    "id" TEXT NOT NULL,
    "activationId" TEXT NOT NULL,
    "mode" "ScoringMode" NOT NULL,
    "outcome" "ScoringAttemptOutcome" NOT NULL,
    "errorKind" TEXT,
    "errorMessage" TEXT,
    "durationMs" INTEGER NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoringAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoringJob" (
    "id" TEXT NOT NULL,
    "activationId" TEXT NOT NULL,
    "mode" "ScoringMode" NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "ScoringJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "trigger" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScoringJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewItem" (
    "id" TEXT NOT NULL,
    "activationId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "openReason" "ReviewOpenReason" NOT NULL,
    "closedAt" TIMESTAMP(3),
    "action" "ReviewAction",
    "reviewerId" TEXT,
    "reason" TEXT,
    "decisionId" TEXT,

    CONSTRAINT "ReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceRequest" (
    "id" TEXT NOT NULL,
    "activationId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "message" TEXT NOT NULL,
    "status" "EvidenceRequestStatus" NOT NULL DEFAULT 'open',
    "respondedAt" TIMESTAMP(3),
    "responseNote" TEXT,

    CONSTRAINT "EvidenceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "activationId" TEXT NOT NULL,
    "decisionId" TEXT,
    "reviewItemId" TEXT,
    "refusedById" TEXT,
    "refusalReason" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'open',
    "openedAt" TIMESTAMP(3) NOT NULL,
    "contestedAt" TIMESTAMP(3),
    "contestNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutAuthorisation" (
    "id" TEXT NOT NULL,
    "activationId" TEXT NOT NULL,
    "amountKsh" INTEGER NOT NULL,
    "payoutMsisdn" TEXT NOT NULL,
    "authorisedAt" TIMESTAMP(3) NOT NULL,
    "authorisedById" TEXT,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,

    CONSTRAINT "PayoutAuthorisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutCycle" (
    "id" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "cutoffAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerActivityDay" (
    "id" TEXT NOT NULL,
    "activationId" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "customerActive" BOOLEAN NOT NULL,
    "transactionCount" INTEGER NOT NULL,
    "topupAmountKsh" DOUBLE PRECISION NOT NULL,
    "usageMinutes" DOUBLE PRECISION NOT NULL,
    "supportContact" BOOLEAN NOT NULL,
    "complaintOrRefund" BOOLEAN NOT NULL,
    "simActive" BOOLEAN NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerActivityDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "activationId" TEXT,
    "fromState" "ActivationState",
    "toState" "ActivationState",
    "actorId" TEXT,
    "detail" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ClientBusiness_userId_key" ON "ClientBusiness"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_userId_key" ON "Agent"("userId");

-- CreateIndex
CREATE INDEX "Assignment_agentId_idx" ON "Assignment"("agentId");

-- CreateIndex
CREATE INDEX "Assignment_jobId_idx" ON "Assignment"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_id_agentId_jobId_key" ON "Assignment"("id", "agentId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowHold_assignmentId_key" ON "EscrowHold"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Activation_reference_key" ON "Activation"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Activation_assignmentId_key" ON "Activation"("assignmentId");

-- CreateIndex
CREATE INDEX "Activation_agentId_submittedAt_idx" ON "Activation"("agentId", "submittedAt");

-- CreateIndex
CREATE INDEX "Activation_deviceId_submittedAt_idx" ON "Activation"("deviceId", "submittedAt");

-- CreateIndex
CREATE INDEX "Activation_customerMsisdnHash_submittedAt_idx" ON "Activation"("customerMsisdnHash", "submittedAt");

-- CreateIndex
CREATE INDEX "Activation_state_idx" ON "Activation"("state");

-- CreateIndex
CREATE UNIQUE INDEX "Activation_assignmentId_agentId_jobId_key" ON "Activation"("assignmentId", "agentId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceItem_activationId_sequence_key" ON "EvidenceItem"("activationId", "sequence");

-- CreateIndex
CREATE INDEX "ScoringDecision_activationId_recordedAt_idx" ON "ScoringDecision"("activationId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScoringReason_decisionId_rank_key" ON "ScoringReason"("decisionId", "rank");

-- CreateIndex
CREATE INDEX "ScoringAttempt_activationId_attemptedAt_idx" ON "ScoringAttempt"("activationId", "attemptedAt");

-- CreateIndex
CREATE INDEX "ScoringJob_status_dueAt_idx" ON "ScoringJob"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScoringJob_activationId_mode_key" ON "ScoringJob"("activationId", "mode");

-- CreateIndex
CREATE INDEX "ReviewItem_activationId_openedAt_idx" ON "ReviewItem"("activationId", "openedAt");

-- CreateIndex
CREATE INDEX "ReviewItem_closedAt_idx" ON "ReviewItem"("closedAt");

-- CreateIndex
CREATE INDEX "EvidenceRequest_activationId_idx" ON "EvidenceRequest"("activationId");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_activationId_key" ON "Dispute"("activationId");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_reviewItemId_key" ON "Dispute"("reviewItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutAuthorisation_activationId_key" ON "PayoutAuthorisation"("activationId");

-- CreateIndex
CREATE INDEX "PayoutCycle_cutoffAt_idx" ON "PayoutCycle"("cutoffAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerActivityDay_activationId_day_key" ON "CustomerActivityDay"("activationId", "day");

-- CreateIndex
CREATE INDEX "AuditEvent_at_idx" ON "AuditEvent"("at");

-- CreateIndex
CREATE INDEX "AuditEvent_activationId_idx" ON "AuditEvent"("activationId");

-- AddForeignKey
ALTER TABLE "ClientBusiness" ADD CONSTRAINT "ClientBusiness_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ClientBusiness"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowDeposit" ADD CONSTRAINT "EscrowDeposit_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowHold" ADD CONSTRAINT "EscrowHold_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activation" ADD CONSTRAINT "Activation_assignmentId_agentId_jobId_fkey" FOREIGN KEY ("assignmentId", "agentId", "jobId") REFERENCES "Assignment"("id", "agentId", "jobId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activation" ADD CONSTRAINT "Activation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activation" ADD CONSTRAINT "Activation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_activationId_fkey" FOREIGN KEY ("activationId") REFERENCES "Activation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_evidenceRequestId_fkey" FOREIGN KEY ("evidenceRequestId") REFERENCES "EvidenceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoringDecision" ADD CONSTRAINT "ScoringDecision_activationId_fkey" FOREIGN KEY ("activationId") REFERENCES "Activation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoringReason" ADD CONSTRAINT "ScoringReason_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "ScoringDecision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoringAttempt" ADD CONSTRAINT "ScoringAttempt_activationId_fkey" FOREIGN KEY ("activationId") REFERENCES "Activation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoringJob" ADD CONSTRAINT "ScoringJob_activationId_fkey" FOREIGN KEY ("activationId") REFERENCES "Activation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewItem" ADD CONSTRAINT "ReviewItem_activationId_fkey" FOREIGN KEY ("activationId") REFERENCES "Activation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewItem" ADD CONSTRAINT "ReviewItem_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceRequest" ADD CONSTRAINT "EvidenceRequest_activationId_fkey" FOREIGN KEY ("activationId") REFERENCES "Activation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceRequest" ADD CONSTRAINT "EvidenceRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_activationId_fkey" FOREIGN KEY ("activationId") REFERENCES "Activation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "ScoringDecision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutAuthorisation" ADD CONSTRAINT "PayoutAuthorisation_activationId_fkey" FOREIGN KEY ("activationId") REFERENCES "Activation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerActivityDay" ADD CONSTRAINT "CustomerActivityDay_activationId_fkey" FOREIGN KEY ("activationId") REFERENCES "Activation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Field-level rules Prisma cannot express. Each one is a physical or business
-- limit, enforced by the database so no write path can bypass it.
ALTER TABLE "Job" ADD CONSTRAINT "Job_payout_positive" CHECK ("payoutPerActivationKsh" > 0);
ALTER TABLE "Job" ADD CONSTRAINT "Job_commission_rate_range" CHECK ("commissionRate" > 0 AND "commissionRate" <= 1);
ALTER TABLE "Job" ADD CONSTRAINT "Job_radius_positive" CHECK ("areaRadiusM" > 0);
ALTER TABLE "Job" ADD CONSTRAINT "Job_slots_positive" CHECK ("slots" > 0);
ALTER TABLE "Job" ADD CONSTRAINT "Job_area_lat_range" CHECK ("areaLat" BETWEEN -90 AND 90);
ALTER TABLE "Job" ADD CONSTRAINT "Job_area_lon_range" CHECK ("areaLon" BETWEEN -180 AND 180);
ALTER TABLE "EscrowDeposit" ADD CONSTRAINT "EscrowDeposit_amount_positive" CHECK ("amountKsh" > 0);
ALTER TABLE "EscrowHold" ADD CONSTRAINT "EscrowHold_amount_positive" CHECK ("amountKsh" > 0);
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_accepted_after_assigned" CHECK ("acceptedAt" IS NULL OR "acceptedAt" >= "assignedAt");
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_home_lat_range" CHECK ("homeLat" BETWEEN -90 AND 90);
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_home_lon_range" CHECK ("homeLon" BETWEEN -180 AND 180);
ALTER TABLE "Activation" ADD CONSTRAINT "Activation_gps_lat_range" CHECK ("gpsLat" BETWEEN -90 AND 90);
ALTER TABLE "Activation" ADD CONSTRAINT "Activation_gps_lon_range" CHECK ("gpsLon" BETWEEN -180 AND 180);
ALTER TABLE "Activation" ADD CONSTRAINT "Activation_gps_accuracy_nonnegative" CHECK ("gpsAccuracyM" IS NULL OR "gpsAccuracyM" >= 0);
ALTER TABLE "Activation" ADD CONSTRAINT "Activation_sim_before_submission" CHECK ("simRegisteredAt" <= "submittedAt");
ALTER TABLE "Activation" ADD CONSTRAINT "Activation_hold_window_ordered" CHECK ("holdClosesAt" IS NULL OR ("heldAt" IS NOT NULL AND "holdClosesAt" >= "heldAt"));
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_sequence_positive" CHECK ("sequence" > 0);
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_gps_pair" CHECK (("gpsLat" IS NULL) = ("gpsLon" IS NULL));
ALTER TABLE "ScoringDecision" ADD CONSTRAINT "ScoringDecision_probability_range" CHECK ("probability" >= 0 AND "probability" <= 1);
ALTER TABLE "ScoringDecision" ADD CONSTRAINT "ScoringDecision_thresholds_ordered" CHECK ("releaseThreshold" <= "rejectThreshold");
ALTER TABLE "ScoringReason" ADD CONSTRAINT "ScoringReason_rank_positive" CHECK ("rank" > 0);
ALTER TABLE "ScoringAttempt" ADD CONSTRAINT "ScoringAttempt_failure_has_kind" CHECK ("outcome" = 'succeeded' OR "errorKind" IS NOT NULL);
ALTER TABLE "ScoringJob" ADD CONSTRAINT "ScoringJob_attempts_nonnegative" CHECK ("attempts" >= 0);
ALTER TABLE "ReviewItem" ADD CONSTRAINT "ReviewItem_closed_has_action" CHECK (("closedAt" IS NULL) = ("action" IS NULL));
ALTER TABLE "PayoutAuthorisation" ADD CONSTRAINT "PayoutAuthorisation_amount_positive" CHECK ("amountKsh" > 0);
ALTER TABLE "PayoutCycle" ADD CONSTRAINT "PayoutCycle_cutoff_after_start" CHECK ("cutoffAt" >= "startsAt");
ALTER TABLE "CustomerActivityDay" ADD CONSTRAINT "CustomerActivityDay_day_range" CHECK ("day" BETWEEN 0 AND 7);
ALTER TABLE "CustomerActivityDay" ADD CONSTRAINT "CustomerActivityDay_counts_nonnegative" CHECK ("transactionCount" >= 0 AND "topupAmountKsh" >= 0 AND "usageMinutes" >= 0);

-- Human-readable activation references (LF-000123).
CREATE SEQUENCE "activation_reference_seq" START 1;
