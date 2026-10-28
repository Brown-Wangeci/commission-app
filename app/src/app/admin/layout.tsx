import type { ReactNode } from "react";
import { TopNav } from "@/components/TopNav";
import { requirePageRole } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requirePageRole("admin");
  return (
    <>
      <TopNav role="admin" userName={user.name} />
      {children}
    </>
  );
}
