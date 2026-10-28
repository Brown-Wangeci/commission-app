import Link from "next/link";
import type { QueuePosition } from "@/lib/review/queue";

/** "← Review queue · Submission N of M" with Previous and Next through the queue. */
export function ReviewBreadcrumb({ position }: { position: QueuePosition | null }) {
  return (
    <div className="breadcrumb">
      <Link href="/admin/review">&larr; Review queue</Link>
      <span aria-hidden="true">&middot;</span>
      <span>{position ? `Submission ${position.index} of ${position.total}` : "Not waiting in the queue"}</span>
      {position && (
        <span className="pager">
          <Link className={`btn small${position.previousId ? "" : " disabled"}`} href={position.previousId ? `/admin/review/${position.previousId}` : "#"} aria-disabled={!position.previousId}>
            Previous
          </Link>
          <Link className={`btn small${position.nextId ? "" : " disabled"}`} href={position.nextId ? `/admin/review/${position.nextId}` : "#"} aria-disabled={!position.nextId}>
            Next
          </Link>
        </span>
      )}
    </div>
  );
}
