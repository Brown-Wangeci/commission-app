import { PrismaClient } from "@prisma/client";

/**
 * One Prisma client per process. In development, Next.js reloads modules on
 * every change, so the client is cached on globalThis to avoid exhausting
 * database connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type Tx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;
