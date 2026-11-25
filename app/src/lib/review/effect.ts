/**
 * The one sentence a client reads next to the review setting. Kept apart from
 * requirement.ts, which reaches the database, so a browser form can import it.
 */
export const REVIEW_SETTING_EFFECT =
  "When this is on, a submission the automated check would have paid goes to a reviewer instead, and is paid only if the reviewer approves it.";
