import type { ReactNode } from "react";
import { TopNav } from "@/components/TopNav";
import { requirePageRole } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** agent-app scopes the 48 px touch-target sizes (NFR-12) to agent screens. */
export default async function AgentLayout({ children }: { children: ReactNode }) {
  const user = await requirePageRole("agent");
  return (
    <div className="agent-app">
      <TopNav role="agent" userName={user.name} />
      {children}
    </div>
  );
}
