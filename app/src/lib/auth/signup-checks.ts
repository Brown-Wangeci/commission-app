import type { FieldErrors } from "@/lib/client-api";
import { HOME_LOCATION_REQUIRED, locationMissing } from "@/lib/location";
import { confirmationProblem, passwordProblems } from "./password-rules";

type Input = { role: "agent" | "client"; password: string; confirmation: string; homeLat: unknown; homeLon: unknown };

/**
 * What stops the sign-up form being sent from the browser: a password that
 * breaks the rule or is not confirmed and, for an agent, no base location
 * chosen (defect 19). Null when it can be sent. The server checks again.
 */
export function browserSignupProblems({ role, password, confirmation, homeLat, homeLon }: Input): { errors: FieldErrors; message: string } | null {
  const errors: FieldErrors = {};
  const problems = passwordProblems(password);
  if (problems.length > 0) errors.password = problems.join(" ");
  if (confirmation === "") errors.confirmPassword = "Type the password again to confirm it.";
  const passwordWrong = Object.keys(errors).length > 0 || Boolean(confirmationProblem(password, confirmation));
  const unplaced = role === "agent" && locationMissing(homeLat, homeLon);
  if (unplaced) errors.homeLat = HOME_LOCATION_REQUIRED;
  if (passwordWrong && unplaced) return { errors, message: "Check the password fields, and choose where you are based." };
  if (passwordWrong) return { errors, message: "Check the password fields below." };
  return unplaced ? { errors, message: HOME_LOCATION_REQUIRED } : null;
}
