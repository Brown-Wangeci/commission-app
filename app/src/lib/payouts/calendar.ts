import type { Tx } from "@/lib/db";

/**
 * The published payout calendar the scoring model reads
 * (`days_to_payout_cutoff`). Cycle length and cutoff hour mirror the
 * `calendar` section of config/generator.yaml at the repository root
 * (`payout_cycle_length_days: 14`, `payout_cutoff_hour: 18.0`, both marked
 * "assumption" there). The anchor, the first cycle's start, is an app-side
 * assumption: Monday 5 January 2026, 00:00 Nairobi time.
 */
export const CYCLE_DAYS = 14;
export const CUTOFF_HOUR_LOCAL = 18;
const NAIROBI_OFFSET_HOURS = 3;
const ANCHOR_UTC = Date.UTC(2026, 0, 5, 0 - NAIROBI_OFFSET_HOURS);
const DAY_MS = 24 * 60 * 60 * 1000;

export type CycleRow = { id: number; startsAt: Date; cutoffAt: Date };

export function cycleRow(id: number): CycleRow {
  const startsAt = new Date(ANCHOR_UTC + id * CYCLE_DAYS * DAY_MS);
  const lastDay = startsAt.getTime() + (CYCLE_DAYS - 1) * DAY_MS;
  const cutoffAt = new Date(lastDay + CUTOFF_HOUR_LOCAL * 60 * 60 * 1000);
  return { id, startsAt, cutoffAt };
}

export function cycleIndexFor(date: Date): number {
  return Math.floor((date.getTime() - ANCHOR_UTC) / (CYCLE_DAYS * DAY_MS));
}

/** Makes sure every cycle from `from` to `through` exists. Safe to call repeatedly. */
export async function ensurePayoutCalendar(db: Tx, from: Date, through: Date): Promise<void> {
  const rows: CycleRow[] = [];
  for (let id = cycleIndexFor(from); id <= cycleIndexFor(through) + 1; id += 1) rows.push(cycleRow(id));
  await db.payoutCycle.createMany({ data: rows, skipDuplicates: true });
}
