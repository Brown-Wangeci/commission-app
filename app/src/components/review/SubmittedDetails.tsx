import Link from "next/link";
import type { ReviewDetail } from "@/lib/review/detail";
import { formatDate, formatDistance, formatDuration, formatTime } from "@/lib/format";

function captureWindow(detail: ReviewDetail): string {
  const { captureStart, captureEnd } = detail.evidenceSummary;
  if (!captureStart || !captureEnd) return "Not recorded";
  const minutes = Math.round((captureEnd.getTime() - captureStart.getTime()) / 60000);
  return `${formatTime(captureStart)} to ${formatTime(captureEnd)} on ${formatDate(captureStart)} (${minutes} min)`;
}

function gpsLine(detail: ReviewDetail): string {
  const s = detail.submission;
  const accuracy = s.gpsAccuracyM !== null ? ` ± ${Math.round(s.gpsAccuracyM)} m` : ", accuracy not recorded";
  const where = s.kmOutsideArea > 0 ? `${formatDistance(s.kmOutsideArea)} outside the job area` : `inside the job area (${detail.job.areaName})`;
  return `${s.gpsLat.toFixed(5)}, ${s.gpsLon.toFixed(5)}${accuracy} · ${where}`;
}

const NETWORK: Record<string, string> = { cellular: "mobile data", wifi: "wifi" };

/** The label/value list of what was submitted. Unrecorded values say so. */
export function SubmittedDetails({ detail }: { detail: ReviewDetail }) {
  const s = detail.submission;
  const regionsDiffer = s.ipRegionName !== null && s.ipRegionName !== s.gpsRegionName;
  return (
    <section className="card card-pad" aria-labelledby="details-heading">
      <h2 id="details-heading" style={{ marginBottom: 8 }}>Submitted details</h2>
      <dl className="dl">
        <dt>Sign-ups claimed</dt>
        <dd>1 <span className="muted small">(each activation is one customer)</span></dd>
        <dt>Capture window</dt>
        <dd>{captureWindow(detail)}</dd>
        <dt>GPS location</dt>
        <dd className="num">{gpsLine(detail)} &middot; <Link href="#location">map</Link></dd>
        <dt>Network region</dt>
        <dd>
          {s.ipRegionName ?? s.ipRegion}
          {regionsDiffer ? <span style={{ color: "var(--raise)" }}> (GPS fix is in {s.gpsRegionName})</span> : " (matches the GPS fix)"}
        </dd>
        <dt>Previous submission</dt>
        <dd>
          {detail.previous ? (
            <>
              {formatDuration(detail.previous.gapMs)} earlier, {formatDistance(detail.previous.distanceKm)} away &middot;{" "}
              <Link href={`/admin/review/${detail.previous.id}`} className="mono">{detail.previous.reference}</Link>
            </>
          ) : (
            "None: this is the agent's first submission"
          )}
        </dd>
        <dt>Device</dt>
        <dd>{s.deviceOs} &middot; app {s.appVersion} &middot; {NETWORK[s.networkType]} &middot; <span className="mono">{s.deviceId}</span></dd>
        <dt>Customer</dt>
        <dd>
          <span className="mono">{s.customerMsisdnMasked}</span> &middot; SIM registered {formatDate(s.simRegisteredAt)} &middot;{" "}
          {s.activationMethod === "qr_scan" ? "details scanned" : "details typed in by hand"}
        </dd>
        <dt>Proof of activation</dt>
        <dd>{detail.proof ? <Link href={`/admin/review/${detail.id}/evidence#proof`}>Attached</Link> : "Not attached"}</dd>
        {s.agentNote && (
          <>
            <dt>Agent&rsquo;s note</dt>
            <dd>{s.agentNote}</dd>
          </>
        )}
        <dt>Payout number</dt>
        <dd className="mono">{detail.payout.payoutMsisdn}</dd>
      </dl>
    </section>
  );
}
