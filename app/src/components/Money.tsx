import { formatCents } from "@/lib/money/cents";

/**
 * An amount as the design system shows money: written in full, in tabular
 * figures, with the derivation line under it whenever the amount was
 * computed rather than entered.
 */
export function Money({ cents, derivation }: { cents: number; derivation?: string | null }) {
  return (
    <>
      <span className="num">{formatCents(cents)}</span>
      {derivation && <span className="derivation">{derivation}</span>}
    </>
  );
}

/** A stat tile holding one amount and, when computed, its derivation. */
export function MoneyStat({ label, cents, derivation }: { label: string; cents: number; derivation?: string | null }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{formatCents(cents)}</div>
      {derivation && <span className="derivation">{derivation}</span>}
    </div>
  );
}
