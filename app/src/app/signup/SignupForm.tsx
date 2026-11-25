"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postJson, type FieldErrors } from "@/lib/client-api";
import { confirmationProblem } from "@/lib/auth/password-rules";
import { browserSignupProblems } from "@/lib/auth/signup-checks";
import { HomeBasePicker } from "@/components/HomeBasePicker";
import { PasswordInput } from "@/components/PasswordInput";
import { PasswordRules } from "@/components/PasswordRules";
import { ChoiceGroup } from "@/components/ChoiceGroup";
import { PhoneInput } from "@/components/PhoneInput";

type Role = "agent" | "client";

function FieldError({ errors, name }: { errors: FieldErrors; name: string }) {
  return errors[name] ? <span className="field-error">{errors[name]}</span> : null;
}

const ROLE_CHOICES = [
  { value: "agent", label: "An agent" },
  { value: "client", label: "A client business" },
];

function bodyFrom(form: FormData, role: Role): Record<string, unknown> {
  const common = {
    role,
    name: form.get("name"),
    email: form.get("email"),
    password: form.get("password"),
  };
  if (role === "client") return { ...common, businessName: form.get("businessName") };
  return {
    ...common,
    payoutMsisdn: form.get("payoutMsisdn"),
    homeAreaName: form.get("homeAreaName"),
    homeLat: form.get("homeLat"),
    homeLon: form.get("homeLon"),
  };
}

export function SignupForm() {
  const router = useRouter();
  const [role, setRole] = useState<Role>("agent");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const mismatch = confirmationProblem(password, confirmation);

  /** Typing in a field clears the error shown for it, so a fixed field is not left marked wrong. */
  function clearError(name: string) {
    setErrors(({ [name]: _removed, ...rest }) => rest);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const blocked = browserSignupProblems({ role, password, confirmation, homeLat: form.get("homeLat"), homeLon: form.get("homeLon") });
    if (blocked) {
      setErrors(blocked.errors);
      setMessage(blocked.message);
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await postJson<{ id: string }>("/api/auth/signup", bodyFrom(form, role));
    if (!result.ok) {
      setBusy(false);
      setErrors(result.fieldErrors);
      setMessage(result.message);
      return;
    }
    await signIn("credentials", { email: form.get("email"), password: form.get("password"), redirect: false });
    router.replace("/");
    router.refresh();
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {message && <div className="alert error" role="alert">{message}</div>}
      <div className="field">
        <span className="label" id="role-label">I am</span>
        <ChoiceGroup name="role" options={ROLE_CHOICES} labelledBy="role-label" value={role} onChange={(value) => setRole(value as Role)} />
      </div>
      <div className="field">
        <label htmlFor="name">Your full name</label>
        <input id="name" name="name" className="input" autoComplete="name" />
        <FieldError errors={errors} name="name" />
      </div>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" className="input" autoComplete="email" />
        <FieldError errors={errors} name="email" />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <PasswordInput id="password" name="password" autoComplete="new-password" value={password} onChange={(value) => { setPassword(value); clearError("password"); }} describedBy="password-rules" invalid={Boolean(errors.password)} />
        <PasswordRules id="password-rules" password={password} />
        <FieldError errors={errors} name="password" />
      </div>
      <div className="field">
        <label htmlFor="confirmPassword">Confirm password</label>
        <PasswordInput id="confirmPassword" name="confirmPassword" autoComplete="new-password" value={confirmation} onChange={(value) => { setConfirmation(value); clearError("confirmPassword"); }} invalid={Boolean(mismatch)} />
        {mismatch ? <span className="field-error" role="status">{mismatch}</span> : confirmation !== "" && <span className="hint" role="status">The passwords match.</span>}
        <FieldError errors={errors} name="confirmPassword" />
      </div>
      {role === "client" ? (
        <div className="field">
          <label htmlFor="businessName">Business name</label>
          <input id="businessName" name="businessName" className="input" />
          <FieldError errors={errors} name="businessName" />
        </div>
      ) : (
        <fieldset className="stack">
          <legend>Payout and base location</legend>
          <div className="field">
            <label htmlFor="payoutMsisdn">M-Pesa payout number</label>
            <PhoneInput id="payoutMsisdn" name="payoutMsisdn" invalid={Boolean(errors.payoutMsisdn)} />
            <FieldError errors={errors} name="payoutMsisdn" />
          </div>
          <HomeBasePicker errors={errors} />
        </fieldset>
      )}
      <button type="submit" className="btn primary block" disabled={busy}>
        {busy ? "Creating account" : "Create account"}
      </button>
      <p className="small muted">Already registered? <Link href="/login">Sign in</Link></p>
    </form>
  );
}
