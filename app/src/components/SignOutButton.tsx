"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button type="button" className="linkbutton" onClick={() => signOut({ callbackUrl: "/login" })}>
      Sign out
    </button>
  );
}
