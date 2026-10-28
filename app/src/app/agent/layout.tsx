import type { ReactNode } from "react";
import { TopNav } from "@/components/TopNav";
import { requirePageRole } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function AgentLayout({ children }: { children: ReactNode }) {
  const user = await requirePageRole("agent");
  return (
    <>
      <TopNav role="agent" userName={user.name} />
      {children}
    </>
  );
}
