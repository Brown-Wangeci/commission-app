import type { ScoringJob, ScoringMode } from "@prisma/client";
import type { Tx } from "@/lib/db";

/** What a reviewer needs to know about scoring problems on one activation. */
export type ScoringHealth = {
  unscoredStage: ScoringMode | null;
  failedAttempts: number;
  lastFailure: { mode: ScoringMode; kind: string; message: string; at: Date } | null;
  pendingRetry: { mode: ScoringMode; dueAt: Date } | null;
  gaveUp: boolean;
};

function retryOf(jobs: ScoringJob[], stage: ScoringMode | null): ScoringJob | undefined {
  return jobs.find((job) => job.mode === stage);
}

export async function scoringHealth(db: Tx, activationId: string, unscoredStage: ScoringMode | null): Promise<ScoringHealth> {
  const [failedAttempts, last, jobs] = await Promise.all([
    db.scoringAttempt.count({ where: { activationId, outcome: "failed" } }),
    db.scoringAttempt.findFirst({ where: { activationId, outcome: "failed" }, orderBy: { attemptedAt: "desc" } }),
    db.scoringJob.findMany({ where: { activationId } }),
  ]);
  const retry = retryOf(jobs, unscoredStage);
  return {
    unscoredStage,
    failedAttempts,
    lastFailure: last ? { mode: last.mode, kind: last.errorKind ?? "unknown", message: last.errorMessage ?? "", at: last.attemptedAt } : null,
    pendingRetry: retry && retry.status === "pending" ? { mode: retry.mode, dueAt: retry.dueAt } : null,
    gaveUp: retry?.status === "failed",
  };
}

const KIND_TEXT: Record<string, string> = {
  timeout: "the scoring service did not answer in time",
  unavailable: "the scoring service could not be reached",
  server_error: "the scoring service returned an error",
  rejected_request: "the scoring service rejected the request",
  invalid_response: "the scoring service sent a response that could not be used",
  missing_input: "information the model needs was missing",
};

export function describeFailureKind(kind: string): string {
  return KIND_TEXT[kind] ?? "the score could not be obtained";
}
