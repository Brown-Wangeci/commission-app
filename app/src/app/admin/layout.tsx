import type { ReactNode } from "react";
import { TopNav } from "@/components/TopNav";
import { requirePageRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { queueCount } from "@/lib/review/queue";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requirePageRole("admin");
  const waiting = await queueCount(prisma);
  return (
    <>
      <TopNav role="admin" userName={user.name} reviewCount={waiting} />
      {children}
    </>
  );
}
