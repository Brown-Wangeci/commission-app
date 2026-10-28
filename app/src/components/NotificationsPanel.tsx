import Link from "next/link";
import { prisma } from "@/lib/db";
import { unreadFor } from "@/lib/notifications";
import { formatDateTime } from "@/lib/format";
import { ActionButton } from "./ActionButton";

/** Unread in-app notifications for one user, with links to the activation they concern. */
export async function NotificationsPanel({ userId, linkBase }: { userId: string; linkBase: string }) {
  const items = await unreadFor(prisma, userId);
  if (items.length === 0) return null;
  return (
    <section className="card" style={{ marginBottom: 20 }} aria-labelledby="notifications-heading">
      <div className="card-pad row-between">
        <h2 id="notifications-heading">Notifications ({items.length})</h2>
        <ActionButton url="/api/notifications/read" body={{ ids: items.map((item) => item.id) }} label="Mark all read" />
      </div>
      <ul className="timeline" style={{ padding: "0 20px 8px" }}>
        {items.map((item) => (
          <li key={item.id}>
            <div className="when">{formatDateTime(item.createdAt)}</div>
            {item.activationId ? <Link href={`${linkBase}/${item.activationId}`}>{item.message}</Link> : item.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
