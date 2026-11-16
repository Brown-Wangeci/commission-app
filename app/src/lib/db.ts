import { PrismaClient, type Prisma } from "@prisma/client";

/**
 * One Prisma client per process. In development, Next.js reloads modules on
 * every change, so the client is cached on globalThis to avoid exhausting
 * database connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * PRISMA_TRANSACTION_TIMEOUT_MS, when set, replaces Prisma's 5 s default for
 * interactive transactions. Unset everywhere the app runs. It is for scripts
 * run far from the database: seeding Neon in Frankfurt from Nairobi costs
 * about 190 ms per query, which takes a T7 decision with its payout past 5 s.
 * It changes how long a transaction may take, never what it does.
 */
export function clientOptions(env: Record<string, string | undefined> = process.env): Prisma.PrismaClientOptions {
  const timeout = Number(env.PRISMA_TRANSACTION_TIMEOUT_MS);
  if (!env.PRISMA_TRANSACTION_TIMEOUT_MS || !Number.isInteger(timeout) || timeout <= 0) return {};
  return { transactionOptions: { timeout, maxWait: timeout } };
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient(clientOptions());

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type Tx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;
