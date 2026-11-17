/** How far ahead the post-a-job form puts the deadline. An assumption, shown to the client and editable. */
export const DEFAULT_DEADLINE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The default deadline as YYYY-MM-DD, counted in Kenya's calendar, so it matches the date the job closes to new work. */
export function defaultDeadline(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(now.getTime() + DEFAULT_DEADLINE_DAYS * DAY_MS),
  );
}
