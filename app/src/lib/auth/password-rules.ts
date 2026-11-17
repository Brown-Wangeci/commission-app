/**
 * The sign-up password rule (length and character classes only), in one place so the server and the form apply the
 * same one. Pure functions only (no bcrypt, no database), so a client component
 * can import it. Sign-in does not use it: an account made under an older rule,
 * such as a seeded demonstration account, still signs in.
 */

/** Assumption, not a published figure: short enough to type on a phone. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
/** Of lower case, upper case, digit and symbol. Assumption. */
export const REQUIRED_CLASSES = 3;

export type PasswordClass = "lower" | "upper" | "digit" | "symbol";

const CLASS_TESTS: Record<PasswordClass, RegExp> = {
  lower: /\p{Ll}/u,
  upper: /\p{Lu}/u,
  digit: /\p{Nd}/u,
  symbol: /[^\p{L}\p{Nd}]/u,
};

export function classesIn(password: string): PasswordClass[] {
  return (Object.keys(CLASS_TESTS) as PasswordClass[]).filter((name) => CLASS_TESTS[name].test(password));
}

export type RuleId = "length" | "classes";
export type RuleCheck = { id: RuleId; ok: boolean; text: string };

/** Each rule with whether the password meets it. The text is what the form shows beside the rule. */
export function checkPassword(password: string): RuleCheck[] {
  const classes = classesIn(password).length;
  return [
    { id: "length", ok: password.length >= MIN_PASSWORD_LENGTH, text: `At least ${MIN_PASSWORD_LENGTH} characters` },
    { id: "classes", ok: classes >= REQUIRED_CLASSES, text: `At least ${REQUIRED_CLASSES} of: lower case, upper case, a digit, a symbol (${classes} so far)` },
  ];
}

const PROBLEM_TEXT: Record<RuleId, string> = {
  length: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  classes: `Use at least ${REQUIRED_CLASSES} of: lower case, upper case, a digit and a symbol.`,
};

/** Every unmet rule, as a sentence each, or an empty list. */
export function passwordProblems(password: string): string[] {
  return checkPassword(password).filter((check) => !check.ok).map((check) => PROBLEM_TEXT[check.id]);
}

/** The message for the confirm field, or null when it matches. An empty confirm field is not yet an error. */
export function confirmationProblem(password: string, confirmation: string): string | null {
  if (confirmation === "") return null;
  return password === confirmation ? null : "The two passwords do not match.";
}
