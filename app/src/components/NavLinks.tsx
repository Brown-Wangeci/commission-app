"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { href: string; label: string; exact?: boolean; badge?: number };

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="navlinks" aria-label="Main">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`navlink${isActive(pathname, item) ? " active" : ""}`}
          aria-current={isActive(pathname, item) ? "page" : undefined}
        >
          {item.label}
          {item.badge !== undefined && (
            <span className={`badge${item.badge === 0 ? " zero" : ""}`} aria-label={`${item.badge} waiting`}>
              {item.badge}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
}
