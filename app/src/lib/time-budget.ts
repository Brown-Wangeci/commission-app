import { config } from "@/lib/config";

/**
 * Time budgets for work done inside one HTTP request (the cron routes and the
 * admin "run due" button). A hosted function is killed at its platform limit
 * (Vercel Hobby with Fluid Compute: 300 s), so a run checks, before it starts
 * each unit of work, that the unit's worst case still fits; whatever does
 * not fit is left due and the next run takes it. Nothing is lost: every queue
 * is a table, and a unit that was cut off mid-way is reclaimed when its lease
 * expires.
 *
 * The long-running scheduler (npm run scheduler) passes NO_DEADLINE and
 * behaves exactly as before.
 */
export const NO_DEADLINE = Number.POSITIVE_INFINITY;

/** Worst case for one scoring run: every immediate attempt times out, with the doubling backoff between them. */
export function scoringRunWorstCaseMs(): number {
  const { SCORING_IMMEDIATE_ATTEMPTS: attempts, SCORING_TIMEOUT_MS: timeout, SCORING_IMMEDIATE_BACKOFF_MS: backoff } = config();
  return attempts * timeout + backoff * (2 ** (attempts - 1) - 1);
}

/** Worst case for one payment instruction: a token request and the instruction itself, each up to MPESA_TIMEOUT_MS. */
export function paymentWorstCaseMs(): number {
  return 2 * config().MPESA_TIMEOUT_MS;
}

/**
 * Reserved for the chain calls an anchoring round makes before and after the
 * receipt wait (viem retries each once, so two timeouts per call).
 */
export function anchorCallsReserveMs(): number {
  return 4 * config().ANCHOR_RPC_TIMEOUT_MS;
}

/** The least time an anchoring round needs to start: its calls before the receipt wait and after it. */
export function anchorRoundMinimumMs(): number {
  return 2 * anchorCallsReserveMs();
}

/**
 * The deadline for a run that starts now. Throws if a single unit of work
 * could not fit in the budget, because such a run would defer everything for
 * ever; that is a configuration error to fix, not to work around.
 */
export function requestDeadline(startedAt: number = Date.now()): number {
  const budgetMs = config().CRON_TIME_BUDGET_SECONDS * 1000;
  const units = { "one scoring run": scoringRunWorstCaseMs(), "one payment instruction": paymentWorstCaseMs(), "an anchoring round": anchorRoundMinimumMs() };
  for (const [unit, worstMs] of Object.entries(units)) {
    if (worstMs > budgetMs) {
      throw new Error(`CRON_TIME_BUDGET_SECONDS (${budgetMs / 1000} s) is shorter than the worst case for ${unit} (${worstMs / 1000} s).`);
    }
  }
  return startedAt + budgetMs;
}

export function remainingMs(deadline: number, now: number = Date.now()): number {
  return deadline - now;
}

/** True when work whose worst case is `worstCaseMs` can still finish before the deadline. */
export function fits(deadline: number, worstCaseMs: number, now: number = Date.now()): boolean {
  return remainingMs(deadline, now) >= worstCaseMs;
}
