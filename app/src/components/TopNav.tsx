import Link from "next/link";
import type { RoleName } from "@/lib/auth/policy";
import { initials } from "@/lib/format";
import { NavLinks, type NavItem } from "./NavLinks";
import { SignOutButton } from "./SignOutButton";

type Props = {
  role: RoleName;
  userName: string;
  reviewCount?: number;
};

function itemsFor(role: RoleName, reviewCount: number | undefined): NavItem[] {
  if (role === "admin") {
    return [
      { href: "/admin", label: "Dashboard", exact: true },
      { href: "/admin/review", label: "Review queue", badge: reviewCount },
      { href: "/admin/agents", label: "Agents" },
      { href: "/admin/clients", label: "Clients" },
      { href: "/admin/payouts", label: "Payouts" },
      { href: "/admin/audit", label: "Audit log" },
    ];
  }
  if (role === "agent") {
    return [
      { href: "/agent", label: "My jobs", exact: true },
      { href: "/agent/activations", label: "My activations" },
    ];
  }
  return [
    { href: "/client", label: "Jobs", exact: true },
    { href: "/client/jobs/new", label: "Post a job" },
  ];
}

export function TopNav({ role, userName, reviewCount }: Props) {
  return (
    <header className="topnav">
      <div className="topnav-inner">
        <Link href="/" className="mark" aria-label="Ledgerfield home">
          <span className="mark-glyph">L</span>
          <span>Ledgerfield</span>
        </Link>
        <NavLinks items={itemsFor(role, reviewCount)} />
        <div className="navuser">
          <span className="avatar" aria-hidden="true">{initials(userName)}</span>
          <span className="navuser-name">{userName}</span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
