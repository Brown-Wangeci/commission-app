import { prisma } from "@/lib/db";
import { requireApiRole } from "@/lib/auth/session";
import { agentStatsMany } from "@/lib/agents/history";
import { ok, withErrors } from "@/lib/http/route";

/** Every agent with their record, for assignment and reporting. */
export const GET = withErrors("GET /api/admin/agents", async () => {
  await requireApiRole("admin");
  const agents = await prisma.agent.findMany({ include: { user: true }, orderBy: { user: { name: "asc" } } });
  const stats = await agentStatsMany(prisma, agents.map((agent) => agent.id));
  return ok({
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.user.name,
      email: agent.user.email,
      homeAreaName: agent.homeAreaName,
      registeredAt: agent.registeredAt,
      stats: stats.get(agent.id),
    })),
  });
});
