-- A client may require a reviewer before any payment on its submissions.
--
-- "ClientBusiness"."reviewAllSubmissions" is the account setting, off for every
-- existing client. "Job"."reviewAllSubmissions" is the optional per-job
-- override: NULL follows the account setting. Additive only: no existing row
-- changes, and code deployed before this migration is unaffected by it.

-- AlterEnum
ALTER TYPE "ReviewOpenReason" ADD VALUE 'client_requires_review';

-- AlterTable
ALTER TABLE "ClientBusiness" ADD COLUMN "reviewAllSubmissions" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "reviewAllSubmissions" BOOLEAN;
