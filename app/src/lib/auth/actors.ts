import type { Agent, ClientBusiness } from "@prisma/client";
import { prisma } from "@/lib/db";
import { forbidden } from "@/lib/http/errors";
import type { SessionUser } from "./session";

/** The agent profile behind a signed-in agent user. */
export async function agentFor(user: SessionUser): Promise<Agent> {
  const agent = await prisma.agent.findUnique({ where: { userId: user.id } });
  if (!agent) throw forbidden();
  return agent;
}

/** The client business behind a signed-in client user. */
export async function clientFor(user: SessionUser): Promise<ClientBusiness> {
  const client = await prisma.clientBusiness.findUnique({ where: { userId: user.id } });
  if (!client) throw forbidden();
  return client;
}
