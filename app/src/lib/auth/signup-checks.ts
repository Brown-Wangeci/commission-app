import type { FieldErrors } from "@/lib/client-api";
import { HOME_LOCATION_REQUIRED, locationProblem } from "@/lib/location";
import { confirmationProblem, passwordProblems } from "./password-rules";

type Input = { role: "agent" | "client"; password: string; confirmation: string; homeLat: unknown; homeLon: unknown };

/**
 * What stops the sign-up form being sent from the browser: a password that
 * breaks the rule or is not confirmed and, for an agent, a base location that
 * is missing (defect 19) or off the globe. Null when it can be sent. The
 * server checks again.
 */
export function browserSignupProblems({ role, password, confirmation, homeLat, homeLon }: Input): { errors: FieldErrors; message: string } | null {
  const errors: FieldErrors = {};
  const problems = passwordProblems(password);
  if (problems.length > 0) errors.password = problems.join(" ");
  if (confirmation === "") errors.confirmPassword = "Type the password again to confirm it.";
  const passwordWrong = Object.keys(errors).length > 0 || Boolean(confirmationProblem(password, confirmation));
  const location = role === "agent" ? locationProblem(homeLat, homeLon, HOME_LOCATION_REQUIRED) : null;
  if (location) errors.homeLat = location;
  if (passwordWrong && location) return { errors, message: "Check the password fields, and choose where you are based." };
  if (passwordWrong) return { errors, message: "Check the password fields below." };
  return location ? { errors, message: location } : null;
}
