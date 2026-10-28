import type { Notification } from "@prisma/client";
import type { Tx } from "@/lib/db";

/**
 * In-app notifications. Shown to the recipient on their home screen until
 * read. SMS or email delivery is not built; this table is the record a
 * delivery channel would read from.
 */
export async function notify(
  db: Tx,
  input: { userId: string; kind: string; message: string; activationId?: string | null },
): Promise<void> {
  await db.notification.create({
    data: { userId: input.userId, kind: input.kind, message: input.message, activationId: input.activationId ?? null },
  });
}

export async function unreadFor(db: Tx, userId: string): Promise<Notification[]> {
  return db.notification.findMany({ where: { userId, readAt: null }, orderBy: { createdAt: "desc" }, take: 20 });
}

export async function markRead(db: Tx, userId: string, ids: string[]): Promise<number> {
  const result = await db.notification.updateMany({
    where: { userId, id: { in: ids }, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}
