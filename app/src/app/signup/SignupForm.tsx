"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { postJson, type FieldErrors } from "@/lib/client-api";

type Role = "agent" | "client";

function FieldError({ errors, name }: { errors: FieldErrors; name: string }) {
  return errors[name] ? <span className="field-error">{errors[name]}</span> : null;
}

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
  const [coords, setCoords] = useState({ lat: "", lon: "" });

  function useMyLocation() {
    navigator.geolocation?.getCurrentPosition(
      (position) =>
        setCoords({ lat: position.coords.latitude.toFixed(5), lon: position.coords.longitude.toFixed(5) }),
      () => setMessage("Location is not available in this browser. Enter the coordinates by hand."),
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
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
        <span className="label">I am</span>
        <div className="row">
          <label className="row small"><input type="radio" name="role" checked={role === "agent"} onChange={() => setRole("agent")} /> An agent</label>
          <label className="row small"><input type="radio" name="role" checked={role === "client"} onChange={() => setRole("client")} /> A client business</label>
        </div>
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
        <input id="password" name="password" type="password" className="input" autoComplete="new-password" />
        <span className="hint">At least 8 characters.</span>
        <FieldError errors={errors} name="password" />
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
            <input id="payoutMsisdn" name="payoutMsisdn" className="input" placeholder="0712 345 678" inputMode="tel" />
            <FieldError errors={errors} name="payoutMsisdn" />
          </div>
          <div className="field">
            <label htmlFor="homeAreaName">Where you are based</label>
            <input id="homeAreaName" name="homeAreaName" className="input" placeholder="e.g. Kariobangi North" />
            <FieldError errors={errors} name="homeAreaName" />
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="homeLat">Latitude</label>
              <input id="homeLat" name="homeLat" className="input" value={coords.lat} onChange={(e) => setCoords({ ...coords, lat: e.target.value })} />
              <FieldError errors={errors} name="homeLat" />
            </div>
            <div className="field">
              <label htmlFor="homeLon">Longitude</label>
              <input id="homeLon" name="homeLon" className="input" value={coords.lon} onChange={(e) => setCoords({ ...coords, lon: e.target.value })} />
              <FieldError errors={errors} name="homeLon" />
            </div>
          </div>
          <button type="button" className="btn small" onClick={useMyLocation}>Use my current location</button>
        </fieldset>
      )}
      <button type="submit" className="btn primary block" disabled={busy}>
        {busy ? "Creating account" : "Create account"}
      </button>
      <p className="small muted">Already registered? <Link href="/login">Sign in</Link></p>
    </form>
  );
}
