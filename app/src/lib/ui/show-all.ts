/**
 * Rows a long list shows before "Show all" (src/components/ShowAllRows.tsx).
 * globals.css (.rows-capped) hides rows from the next one on, so the two
 * change together. Kept out of the client component so server pages can read
 * the number too.
 */
export const SHOW_ALL_INITIAL = 25;
