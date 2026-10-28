import type { ReviewDetail } from "@/lib/review/detail";
import { distanceKm } from "@/lib/geo";
import { formatDistance } from "@/lib/format";

/**
 * Where it happened: the job area, the submission's GPS fix, each located
 * photo, the previous submission and the agent's base, drawn to scale from
 * the recorded coordinates. Points more than OFF_MAP_KM from the job area are
 * listed instead of drawn, so one far point cannot shrink the rest.
 */
const WIDTH = 640;
const HEIGHT = 340;
const PAD = 28;
const KM_PER_DEGREE = 111.32;
const OFF_MAP_KM = 40;

type Pt = { x: number; y: number };
type Marker = { key: string; lat: number; lon: number; kind: "submission" | "photo" | "photo-out" | "previous" | "base"; label: string };

function markers(detail: ReviewDetail): Marker[] {
  const list: Marker[] = [{ key: "sub", lat: detail.submission.gpsLat, lon: detail.submission.gpsLon, kind: "submission", label: "Submission" }];
  for (const photo of detail.photos) {
    if (photo.gpsLat === null || photo.gpsLon === null) continue;
    const out = (photo.kmOutsideArea ?? 0) > 0;
    list.push({ key: `p${photo.sequence}`, lat: photo.gpsLat, lon: photo.gpsLon, kind: out ? "photo-out" : "photo", label: String(photo.sequence) });
  }
  if (detail.previous) {
    list.push({ key: "prev", lat: detail.previous.gpsLat, lon: detail.previous.gpsLon, kind: "previous", label: detail.previous.reference });
  }
  list.push({ key: "base", lat: detail.agent.homeLat, lon: detail.agent.homeLon, kind: "base", label: "Agent's base" });
  return list;
}

function niceScale(km: number): number {
  const options = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20];
  return options.reduce((best, option) => (Math.abs(option - km) < Math.abs(best - km) ? option : best), options[0]);
}

export function LocationPlot({ detail }: { detail: ReviewDetail }) {
  const centre = { lat: detail.job.areaLat, lon: detail.job.areaLon };
  const cosLat = Math.cos((centre.lat * Math.PI) / 180);
  const toKm = (lat: number, lon: number) => ({ x: (lon - centre.lon) * cosLat * KM_PER_DEGREE, y: -(lat - centre.lat) * KM_PER_DEGREE });

  const all = markers(detail);
  const near = all.filter((m) => distanceKm(centre.lat, centre.lon, m.lat, m.lon) <= OFF_MAP_KM);
  const far = all.filter((m) => !near.includes(m));

  const radiusKm = detail.job.areaRadiusM / 1000;
  const xs = [-radiusKm, radiusKm, ...near.map((m) => toKm(m.lat, m.lon).x)];
  const ys = [-radiusKm, radiusKm, ...near.map((m) => toKm(m.lat, m.lon).y)];
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((WIDTH - 2 * PAD) / Math.max(maxX - minX, 0.2), (HEIGHT - 2 * PAD) / Math.max(maxY - minY, 0.2));
  const offsetX = (WIDTH - (maxX - minX) * scale) / 2;
  const offsetY = (HEIGHT - (maxY - minY) * scale) / 2;
  const project = (lat: number, lon: number): Pt => {
    const km = toKm(lat, lon);
    return { x: offsetX + (km.x - minX) * scale, y: offsetY + (km.y - minY) * scale };
  };

  const area = project(centre.lat, centre.lon);
  const sub = project(detail.submission.gpsLat, detail.submission.gpsLon);
  const previous = near.find((m) => m.kind === "previous");
  const prev = previous ? project(previous.lat, previous.lon) : null;
  const barKm = niceScale(((WIDTH - 2 * PAD) / scale) / 5);
  const osm = `https://www.openstreetmap.org/?mlat=${detail.submission.gpsLat.toFixed(5)}&mlon=${detail.submission.gpsLon.toFixed(5)}#map=15/${detail.submission.gpsLat.toFixed(5)}/${detail.submission.gpsLon.toFixed(5)}`;

  return (
    <section className="card card-pad target" id="location" aria-labelledby="location-heading">
      <div className="row-between" style={{ marginBottom: 10 }}>
        <h2 id="location-heading">Where it happened</h2>
        <a className="small" href={osm} target="_blank" rel="noreferrer">Open in OpenStreetMap</a>
      </div>
      <svg className="plot" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Plot of the job area, the submission, the photos and the agent's base">
        <circle cx={area.x} cy={area.y} r={radiusKm * scale} fill="rgba(29,90,70,0.08)" stroke="var(--accent)" strokeDasharray="5 4" strokeWidth="1.5" />
        <text x={area.x} y={area.y + radiusKm * scale + 14} textAnchor="middle" fontSize="11" fill="var(--accent)">{detail.job.areaName} (job area)</text>
        {prev && <line x1={prev.x} y1={prev.y} x2={sub.x} y2={sub.y} stroke="var(--lower)" strokeDasharray="4 4" strokeWidth="1.5" />}
        {near.map((m) => {
          const p = project(m.lat, m.lon);
          if (m.kind === "base") return <g key={m.key}><rect x={p.x - 6} y={p.y - 6} width="12" height="12" fill="var(--ink-2)" /><text x={p.x + 10} y={p.y + 4} fontSize="11" fill="var(--ink-2)">{m.label}</text></g>;
          if (m.kind === "previous") return <g key={m.key}><circle cx={p.x} cy={p.y} r="7" fill="var(--surface)" stroke="var(--lower)" strokeWidth="2" /><text x={p.x + 10} y={p.y + 4} fontSize="11" fill="var(--lower)">Previous ({m.label})</text></g>;
          if (m.kind === "submission") return <g key={m.key}><circle cx={p.x} cy={p.y} r="7" fill="var(--ink)" /><text x={p.x - 12} y={p.y + 4} textAnchor="end" fontSize="11" fill="var(--ink)">Submission</text></g>;
          const out = m.kind === "photo-out";
          return <g key={m.key}><circle cx={p.x} cy={p.y} r="8" fill={out ? "var(--raise)" : "var(--surface)"} stroke={out ? "var(--raise)" : "var(--ink-2)"} /><text x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize="9" fontWeight="700" fill={out ? "#fff" : "var(--ink)"}>{m.label}</text></g>;
        })}
        <g transform={`translate(${PAD}, ${HEIGHT - 14})`}>
          <line x1="0" y1="0" x2={barKm * scale} y2="0" stroke="var(--ink-2)" strokeWidth="2" />
          <text x={barKm * scale + 6} y="4" fontSize="11" fill="var(--ink-2)">{formatDistance(barKm)}</text>
        </g>
      </svg>
      <div className="plot-legend">
        <span><i className="swatch" style={{ background: "var(--ink)" }} /> Submission GPS fix</span>
        <span><i className="swatch" style={{ border: "1px solid var(--ink-2)" }} /> Photo inside the job area</span>
        <span><i className="swatch" style={{ background: "var(--raise)" }} /> Photo outside the job area</span>
        {detail.previous && <span><i className="swatch" style={{ border: "2px solid var(--lower)" }} /> Previous submission</span>}
        <span><i className="swatch" style={{ background: "var(--ink-2)", borderRadius: 0 }} /> Agent&rsquo;s base ({detail.agent.homeAreaName})</span>
      </div>
      {far.length > 0 && (
        <p className="tiny muted" style={{ marginTop: 6 }}>
          Off the map (more than {OFF_MAP_KM} km away): {far.map((m) => `${m.label}, ${formatDistance(distanceKm(centre.lat, centre.lon, m.lat, m.lon))} from the job area`).join("; ")}.
        </p>
      )}
    </section>
  );
}
