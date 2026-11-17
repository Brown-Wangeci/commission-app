import { checkPassword } from "@/lib/auth/password-rules";

/**
 * The rules a new password must meet, with each one's state as the person
 * types. The state is written in words as well as drawn, so it does not
 * depend on colour. Before anything is typed every rule reads "not yet".
 */
export function PasswordRules({ password, id }: { password: string; id: string }) {
  const checks = checkPassword(password);
  const started = password.length > 0;
  return (
    <ul className="rules" id={id} aria-live="polite" aria-label="Password rules">
      {checks.map((check) => {
        const met = started && check.ok;
        return (
          <li key={check.id} className={met ? "met" : "unmet"}>
            <span className="rule-state">{met ? "Met" : "Not yet"}</span> {check.text}
          </li>
        );
      })}
    </ul>
  );
}
