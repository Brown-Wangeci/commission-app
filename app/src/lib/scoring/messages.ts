/**
 * The one message a scoring run records when a hold-close (T7) score cannot be
 * built because the customer's first week of activity was never reported. It is
 * shared so the screens can tell this case apart from the scoring service being
 * unreachable, without matching on loose text.
 */
export const NO_ACTIVITY_MESSAGE = "no first-week customer activity has been reported for this activation";

export function isMissingActivity(failure: { kind: string; message: string } | null): boolean {
  return failure !== null && failure.kind === "missing_input" && failure.message === NO_ACTIVITY_MESSAGE;
}
