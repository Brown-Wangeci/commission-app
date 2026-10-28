import type { ReactNode } from "react";
import { TopNav } from "@/components/TopNav";
import { requirePageRole } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function ClientLayout({ children }: { children: ReactNode }) {
  const user = await requirePageRole("client");
  return (
    <>
      <TopNav role="client" userName={user.name} />
      {children}
    </>
  );
}
