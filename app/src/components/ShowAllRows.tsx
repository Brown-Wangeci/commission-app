"use client";

import { useState, type ReactNode } from "react";
import { SHOW_ALL_INITIAL } from "@/lib/ui/show-all";

type Props = {
  /** How many rows the table inside holds. */
  total: number;
  /** What the rows are, plural, for the button: "assignments", "payouts". */
  noun: string;
  /** Show every row regardless, for when the rows past the cap still need someone to act. */
  uncapped?: boolean;
  children: ReactNode;
};

/**
 * Wraps a table whose rows are all rendered, and shows only the first
 * SHOW_ALL_INITIAL until the reader asks for the rest. Nothing is fetched:
 * the hidden rows are already on the page, so search in page still finds them
 * once shown, and a table with SHOW_ALL_INITIAL rows or fewer is untouched.
 */
export function ShowAllRows({ total, noun, uncapped = false, children }: Props) {
  const [all, setAll] = useState(false);
  const capped = !uncapped && total > SHOW_ALL_INITIAL;
  return (
    <div className={capped && !all ? "rows-capped" : undefined}>
      {children}
      {capped && (
        <div className="rows-more">
          <button type="button" className="btn small" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? `Show the first ${SHOW_ALL_INITIAL} only` : `Show all ${total} ${noun}`}
          </button>
        </div>
      )}
    </div>
  );
}
