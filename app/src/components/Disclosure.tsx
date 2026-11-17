"use client";

import { useEffect, useRef, type ReactNode } from "react";

type Props = {
  /** Anchor for links such as #location. A link to this id, or to any element inside, opens the section. */
  id: string;
  title: string;
  /** One line shown beside the title while closed, so the reader knows what is inside. */
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
};

/**
 * A section that opens on click. Built on <details>, so it works without
 * script and by keyboard. A script only adds one thing: when the address
 * points at the section (or at something inside it), it opens, so in-page
 * links such as "Show the location on a map" still land on what they name.
 */
export function Disclosure({ id, title, hint, defaultOpen = false, children }: Props) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function openIfTargeted() {
      const hash = window.location.hash.slice(1);
      if (!hash || !ref.current) return;
      const target = document.getElementById(hash);
      if (target && ref.current.contains(target)) {
        ref.current.open = true;
        target.scrollIntoView();
      }
    }
    openIfTargeted();
    window.addEventListener("hashchange", openIfTargeted);
    return () => window.removeEventListener("hashchange", openIfTargeted);
  }, []);

  return (
    <details className="disclosure target" id={id} ref={ref} open={defaultOpen}>
      <summary>
        <h2>{title}</h2>
        {hint && <span className="disclosure-hint">{hint}</span>}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
