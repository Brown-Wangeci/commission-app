import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/errors";
import { reviewDetail, type EvidenceView } from "@/lib/review/detail";
import { formatDateTime, formatDistance } from "@/lib/format";

function describe(item: EvidenceView): string {
  const parts = [item.capturedAt ? `captured ${formatDateTime(item.capturedAt)}` : "capture time not recorded"];
  if (item.gpsLat !== null && item.gpsLon !== null) {
    const accuracy = item.gpsAccuracyM !== null ? ` ± ${Math.round(item.gpsAccuracyM)} m` : "";
    parts.push(`${item.gpsLat.toFixed(5)}, ${item.gpsLon.toFixed(5)}${accuracy}`);
    parts.push((item.kmOutsideArea ?? 0) > 0 ? `${formatDistance(item.kmOutsideArea!)} outside the job area` : "inside the job area");
  } else {
    parts.push("no location recorded");
  }
  if (item.fromRequestId) parts.push("sent in response to an evidence request");
  return parts.join(" · ");
}

/** Every evidence item for one submission, with its capture time and place. */
export default async function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const detail = await reviewDetail(prisma, id).catch((error) => {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  });
  const items = detail.proof ? [...detail.photos, detail.proof] : detail.photos;
  return (
    <main className="page">
      <div className="breadcrumb">
        <Link href={`/admin/review/${id}`}>&larr; Back to {detail.reference}</Link>
      </div>
      <div className="page-header">
        <div>
          <h1>Evidence for {detail.reference}</h1>
          <p className="muted small">{detail.job.title} &middot; {detail.agent.name}</p>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="card empty">No evidence was attached.</div>
      ) : (
        <div className="gallery">
          {items.map((item) => (
            <figure key={item.id} id={item.kind === "proof" ? "proof" : `photo-${item.sequence}`} className="target">
              <a href={item.url} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.url} alt={item.kind === "proof" ? "Proof of activation" : `Evidence photo ${item.sequence}`} />
              </a>
              <figcaption>
                <strong>{item.kind === "proof" ? "Proof of activation" : `Photo ${item.sequence}`}</strong>
                <br />
                {describe(item)}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </main>
  );
}
