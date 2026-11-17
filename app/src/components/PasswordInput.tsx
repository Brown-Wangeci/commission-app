"use client";

import { useState } from "react";

type Props = {
  id: string;
  name: string;
  autoComplete: "current-password" | "new-password";
  value?: string;
  onChange?: (value: string) => void;
  required?: boolean;
  describedBy?: string;
  invalid?: boolean;
};

/** The input type for a password field: dots while hidden, plain text while shown. */
export function passwordInputType(visible: boolean): "text" | "password" {
  return visible ? "text" : "password";
}

/**
 * A password field with its own show/hide control. The control is a real
 * button after the input, so it is reachable by keyboard, announces its state
 * with aria-pressed, and never submits the form.
 */
export function PasswordInput({ id, name, autoComplete, value, onChange, required, describedBy, invalid }: Props) {
  const [visible, setVisible] = useState(false);
  const label = visible ? "Hide password" : "Show password";
  const controlled = value !== undefined && onChange !== undefined;
  return (
    <div className="password-field">
      <input
        id={id}
        name={name}
        type={passwordInputType(visible)}
        className="input"
        autoComplete={autoComplete}
        required={required}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        {...(controlled ? { value, onChange: (event) => onChange(event.target.value) } : {})}
      />
      <button type="button" className="btn small password-toggle" aria-pressed={visible} aria-controls={id} aria-label={label} onClick={() => setVisible(!visible)}>
        {visible ? "Hide" : "Show"}
      </button>
    </div>
  );
}

