"use client";

import { useState, type CSSProperties } from "react";
import { groupPhone } from "@/lib/ui/format";

type Props = {
  id: string;
  name: string;
  defaultValue?: string;
  /** "tel-national" for the person's own number; "off" for someone else's, such as a customer's. */
  autoComplete?: string;
  invalid?: boolean;
  style?: CSSProperties;
};

/**
 * A Kenyan mobile number input that groups the digits as they are typed
 * (0712 345 678). The value sent keeps the spaces; the server removes them
 * before it checks the number, exactly as it did for a number typed with
 * spaces by hand.
 */
export function PhoneInput({ id, name, defaultValue = "", autoComplete = "tel-national", invalid = false, style }: Props) {
  const [value, setValue] = useState(groupPhone(defaultValue));
  return (
    <input
      id={id}
      name={name}
      className="input"
      inputMode="tel"
      autoComplete={autoComplete}
      placeholder="0712 345 678"
      value={value}
      onChange={(event) => setValue(groupPhone(event.target.value))}
      aria-invalid={invalid || undefined}
      style={style}
    />
  );
}
