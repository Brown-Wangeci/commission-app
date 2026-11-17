import Link from "next/link";
import type { ReactNode } from "react";

type Props = {
  /** What there is none of, in a few words. */
  title: string;
  /** What will appear here, and when. */
  children: ReactNode;
  /** Who acts next, and what they do. */
  next: ReactNode;
  action?: { href: string; label: string };
};

/**
 * What a list says when it has no rows: that it is empty, what will appear
 * in it, and who acts next. Every list uses this, so none is a blank card.
 */
export function EmptyState({ title, children, next, action }: Props) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      <p className="empty-body">{children}</p>
      <p className="empty-next"><span className="empty-next-label">Next</span> {next}</p>
      {action && <Link href={action.href} className="btn small empty-action">{action.label}</Link>}
    </div>
  );
}
