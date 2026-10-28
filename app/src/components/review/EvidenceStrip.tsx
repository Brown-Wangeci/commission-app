import Link from "next/link";
import type { ReviewDetail } from "@/lib/review/detail";
import { formatDistance, formatTime } from "@/lib/format";

const VISIBLE = 5;

function captionParts(detail: ReviewDetail): Array<{ text: string; warn?: boolean }> {
  const s = detail.evidenceSummary;
  const parts: Array<{ text: string; warn?: boolean }> = [{ text: `${s.photoCount} photo${s.photoCount === 1 ? "" : "s"}` }];
  parts.push({
    text: s.captureStart && s.captureEnd ? `captured ${formatTime(s.captureStart)} to ${formatTime(s.captureEnd)}` : "capture time not recorded",
  });
  parts.push({
    text: s.accuracyMin !== null && s.accuracyMax !== null ? `GPS accuracy ${Math.round(s.accuracyMin)} to ${Math.round(s.accuracyMax)} m` : "GPS accuracy not recorded",
  });
  if (s.withoutLocation > 0) parts.push({ text: `${s.withoutLocation} without a location` });
  for (const outside of s.outside) {
    parts.push({ text: `photo ${outside.sequence} taken ${formatDistance(outside.km)} outside the job area`, warn: true });
  }
  if (s.outside.length === 0 && s.withoutLocation < s.photoCount) parts.push({ text: "all located photos inside the job area" });
  parts.push({ text: s.proofAttached ? "proof of activation attached" : "no proof of activation attached", warn: !s.proofAttached });
  return parts;
}

export function EvidenceStrip({ detail }: { detail: ReviewDetail }) {
  const galleryHref = `/admin/review/${detail.id}/evidence`;
  const shown = detail.photos.slice(0, VISIBLE);
  const hidden = detail.photos.length - shown.length;
  return (
    <section className="card card-pad" aria-labelledby="submitted-heading">
      <div className="row-between" style={{ marginBottom: 12 }}>
        <h2 id="submitted-heading">What the agent submitted</h2>
        {detail.photos.length > 0 && <Link href={galleryHref} className="small">View all {detail.photos.length}</Link>}
      </div>
      {detail.photos.length === 0 ? (
        <p className="muted small">No photos were attached.</p>
      ) : (
        <div className="thumbs">
          {shown.map((photo) => {
            const outside = (photo.kmOutsideArea ?? 0) > 0;
            return (
              <Link key={photo.id} href={`${galleryHref}#photo-${photo.sequence}`} className={`thumb${outside ? " outside" : ""}`} title={`Photo ${photo.sequence}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.url} alt={`Evidence photo ${photo.sequence}`} loading="lazy" />
                <span className="n">{photo.sequence}</span>
                {outside && <span className="flag">Outside area</span>}
              </Link>
            );
          })}
          {hidden > 0 && <Link href={galleryHref} className="thumb more" aria-label={`${hidden} more photos`}>+{hidden}</Link>}
        </div>
      )}
      <p className="caption">
        {captionParts(detail).map((part, index) => (
          <span key={index}>
            {index > 0 && " · "}
            <span className={part.warn ? "warn-text" : undefined}>{part.text}</span>
          </span>
        ))}
      </p>
    </section>
  );
}
