import Link from "next/link";
import type { EvidenceView, PhotoGroup, ReviewDetail } from "@/lib/review/detail";
import { formatTime } from "@/lib/format";

/** Tiles shown per group before the overflow tile ("+N, View all"). */
const VISIBLE = 5;

function captionParts(detail: ReviewDetail): Array<{ text: string; warn?: boolean }> {
  const s = detail.evidenceSummary;
  const parts: Array<{ text: string; warn?: boolean }> = [{ text: `${s.photoCount} photo${s.photoCount === 1 ? "" : "s"}` }];
  parts.push({ text: s.captureStart && s.captureEnd ? `captured ${formatTime(s.captureStart)} to ${formatTime(s.captureEnd)}` : "capture time not recorded" });
  if (s.outside.length === 0 && s.withoutLocation < s.photoCount) parts.push({ text: "all located photos inside the job area" });
  parts.push({ text: s.proofAttached ? "proof of activation attached" : "no proof of activation attached", warn: !s.proofAttached });
  return parts;
}

function pad(sequence: number): string {
  return String(sequence).padStart(2, "0");
}

/** One tile: the photo, its number, and under it its own capture time and GPS accuracy; a flag's reason is written inline. */
function Tile({ photo, href }: { photo: EvidenceView; href: string }) {
  const time = photo.capturedAt ? formatTime(photo.capturedAt) : "Time not recorded";
  const accuracy = photo.gpsAccuracyM !== null ? `± ${Math.round(photo.gpsAccuracyM)} m` : "Accuracy not recorded";
  return (
    <figure className={`tile${photo.flag ? " flagged" : ""}`}>
      <Link href={href} className="tile-img" aria-label={`Photo ${photo.sequence}${photo.flag ? `, flagged: ${photo.flag}` : ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo.url} alt={`Evidence photo ${photo.sequence}`} loading="lazy" />
        <span className="tile-n">{pad(photo.sequence)}</span>
      </Link>
      <figcaption>
        <span className="num">{time}</span> &middot; <span className="num">{accuracy}</span>
        {photo.flag && <span className="tile-flag">{photo.flag}</span>}
      </figcaption>
    </figure>
  );
}

/**
 * The tiles shown before the overflow tile. Flagged photos take the visible
 * places first, so a flag's reason is always on the screen rather than behind
 * "View all"; the chosen tiles keep their evidence order.
 */
export function visibleTiles(photos: EvidenceView[]): EvidenceView[] {
  if (photos.length <= VISIBLE + 1) return photos;
  const chosen = [...photos.filter((p) => p.flag), ...photos.filter((p) => !p.flag)].slice(0, VISIBLE);
  return chosen.sort((a, b) => a.sequence - b.sequence);
}

function Group({ group, galleryHref }: { group: PhotoGroup; galleryHref: string }) {
  const shown = visibleTiles(group.photos);
  const overflow = shown.length < group.photos.length;
  return (
    <div className="stack-sm">
      <h3 className="group-label">
        {group.label} <span className="muted small">({group.photos.length}{group.format ? `; ${group.format.toLowerCase()}` : ""})</span>
      </h3>
      {group.photos.length === 0 ? (
        <p className="small muted">No photos.</p>
      ) : (
        <div className="tile-grid">
          {shown.map((photo) => <Tile key={photo.id} photo={photo} href={`${galleryHref}#photo-${photo.sequence}`} />)}
          {overflow && (
            <Link href={galleryHref} className="tile-more">
              <span className="tile-more-n">+{group.photos.length - shown.length}</span>
              <span>View all {group.photos.length}</span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The evidence thumbnail grid (issue #50): one group per photo field of the
 * submission's own configuration version, labelled as the client configured
 * it, then any photos sent in reply to an evidence request.
 */
export function EvidenceStrip({ detail }: { detail: ReviewDetail }) {
  const galleryHref = `/admin/review/${detail.id}/evidence`;
  const { version, currentVersion, photoGroups } = detail.evidence;
  return (
    <section className="card card-pad stack" aria-labelledby="submitted-heading">
      <div className="row-between">
        <h2 id="submitted-heading">What the agent submitted</h2>
        {detail.photos.length > 0 && <Link href={galleryHref} className="small">View all {detail.photos.length}</Link>}
      </div>
      <p className="tiny muted" style={{ margin: 0 }}>
        Evidence fields version {version}
        {currentVersion !== version ? `; the job has since moved to version ${currentVersion}, which this submission is not judged against` : ""}.
      </p>
      {photoGroups.length === 0 ? <p className="small muted">This job asks for no photos.</p> : photoGroups.map((group) => <Group key={group.key} group={group} galleryHref={galleryHref} />)}
      <p className="caption" style={{ marginTop: 0 }}>
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
