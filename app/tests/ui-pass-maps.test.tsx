import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AreaStatus, areaStatus } from "@/components/agent/AreaStatus";
import { JobAreaPicker, coordinate } from "@/components/client/JobAreaPicker";
import { DEFAULT_RADIUS_M, PostJobForm } from "@/components/client/PostJobForm";
import { securityHeaders } from "@/lib/http/https-policy";
import { jobInputSchema } from "@/lib/jobs/jobs";
import { MAP_HOSTS, TILE_ATTRIBUTION, TILE_URL } from "@/lib/map/config";
import { MIN_INTERVAL_MS, createGeocoder, parsePlaces, searchUrl } from "@/lib/map/geocode";
import { RADIUS_STEPS_M, radiusLabel, radiusStepIndex } from "@/lib/map/radius";

/**
 * UI pass, PR 3: the job-area map picker on the post-a-job form, and the
 * agent's "inside the job area" line. The picker fills the same three form
 * fields the typed coordinates did; these tests hold that, the services'
 * usage policies, and the wording the agent sees.
 */
// The post-a-job form uses the app router; rendering it here needs only a stand-in.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
// The schema is refined as a whole (superRefine), so its object shape sits one level in.
const radiusSchema = jobInputSchema.innerType().shape.areaRadiusM;

describe("the radius slider's steps stay inside what the server accepts", () => {
  it("runs from the smallest to the largest radius the server accepts, rising, and includes the default", () => {
    expect(radiusSchema.safeParse(RADIUS_STEPS_M[0]).success).toBe(true);
    expect(radiusSchema.safeParse(RADIUS_STEPS_M[0] - 1).success).toBe(false);
    expect(radiusSchema.safeParse(RADIUS_STEPS_M.at(-1)).success).toBe(true);
    expect(radiusSchema.safeParse(RADIUS_STEPS_M.at(-1)! + 1).success).toBe(false);
    expect(RADIUS_STEPS_M.every((step, i) => i === 0 || step > RADIUS_STEPS_M[i - 1])).toBe(true);
    expect(RADIUS_STEPS_M).toContain(Number(DEFAULT_RADIUS_M));
    for (const step of RADIUS_STEPS_M) expect(radiusSchema.safeParse(step).success).toBe(true);
  });

  it("finds the nearest step and labels a radius in metres or kilometres", () => {
    expect(RADIUS_STEPS_M[radiusStepIndex(800)]).toBe(700);
    expect(RADIUS_STEPS_M[radiusStepIndex(900)]).toBe(1000);
    expect([radiusLabel(700), radiusLabel(1500), radiusLabel(20_000)]).toEqual(["700 m", "1.5 km", "20 km"]);
  });
});

describe("place search keeps to the Nominatim usage policy", () => {
  const answer = [{ lat: "-1.2833", lon: "36.8333", display_name: "Gikomba Market, Nairobi, Kenya", boundingbox: ["-1.29", "-1.27", "36.82", "36.84"] }];
  const fakeFetch = (calls: string[]) =>
    (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as unknown as typeof fetch;

  it("asks for a few results in Kenya, as JSON", () => {
    const url = new URL(searchUrl("https://nominatim.openstreetmap.org", "Gikomba Market"));
    expect(url.pathname).toBe("/search");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ format: "jsonv2", q: "Gikomba Market", limit: "5", countrycodes: "ke" });
  });

  it("reads places and their boxes, leaving out anything malformed", () => {
    expect(parsePlaces(answer)).toEqual([{ name: "Gikomba Market, Nairobi, Kenya", lat: -1.2833, lon: 36.8333, bounds: [-1.29, -1.27, 36.82, 36.84] }]);
    expect(parsePlaces([{ lat: "x", lon: "1", display_name: "bad" }, { display_name: "no coordinates" }])).toEqual([]);
    expect(parsePlaces({ error: "nope" })).toEqual([]);
  });

  it("spaces requests at least a second apart", async () => {
    const calls: string[] = [];
    let clock = 10_000;
    const waits: number[] = [];
    const search = createGeocoder("https://n.test", { fetcher: fakeFetch(calls), now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; } });
    await search("Gikomba");
    clock += 200;
    await search("Kibuye");
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([MIN_INTERVAL_MS - 200]);
  });

  it("answers a repeated query from its cache and sends nothing for an empty one", async () => {
    const calls: string[] = [];
    const search = createGeocoder("https://n.test", { fetcher: fakeFetch(calls), wait: async () => {} });
    await search("Gikomba Market");
    await search("  gikomba   market ");
    await search("   ");
    expect(calls).toHaveLength(1);
  });

  it("searches only when asked: Enter or the Search button, never on typing", () => {
    const source = read("src/components/client/JobAreaPicker.tsx");
    expect(source).toContain("onChange={(e) => setQuery(e.target.value)}");
    expect(source.match(/void runSearch\(\)/g)).toHaveLength(2);
    expect(source).toContain('if (event.key !== "Enter") return;');
    expect(source).toContain('onClick={() => void runSearch()}');
  });
});

describe("the picker fills the same form fields the typed coordinates did", () => {
  const html = renderToStaticMarkup(<JobAreaPicker errors={{}} defaultRadiusM={700} />);

  it("renders the three fields, read-only, under Advanced, with the default radius", () => {
    expect(html).toMatch(/<details class="help-more"><summary class="small">Advanced: the values sent<\/summary>/);
    const tag = (id: string) => html.match(new RegExp(`<input id="${id}"[^>]*/>`))?.[0] ?? "";
    for (const [id, value] of [["areaLat", ""], ["areaLon", ""], ["areaRadiusM", "700"]]) {
      expect(tag(id)).toContain(`name="${id}"`);
      expect(tag(id)).toContain('readOnly=""');
      expect(tag(id)).toContain(`value="${value}"`);
    }
  });

  it("offers place search, the map, the device's location, a centre pin and the radius slider", () => {
    expect(html).toContain('id="placeSearch" type="search"');
    expect(html).toContain('class="map-canvas" role="region"');
    expect(html).toContain("Use my location");
    expect(html).toContain("Put the pin at the map centre");
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-valuetext="700 m"');
    expect(html).toContain('name="areaName"');
  });

  it("sends coordinates to six decimals, as typed ones would parse", () => {
    expect(coordinate(-0.0995)).toBe("-0.099500");
    expect(Number(coordinate(34.768))).toBe(34.768);
  });

  it("is the job area of the post-a-job form", () => {
    const form = renderToStaticMarkup(<PostJobForm availableCents={0} defaultDeadline="2026-12-25" accountReviewSetting={false} />);
    for (const name of ["areaName", "areaLat", "areaLon", "areaRadiusM"]) expect(form).toContain(`name="${name}"`);
    expect(read("src/components/client/PostJobForm.tsx")).toContain("<JobAreaPicker errors={errors} defaultRadiusM={Number(DEFAULT_RADIUS_M)} />");
  });
});

describe("the map keeps to the tile policy and the app's security headers allow it", () => {
  it("uses OpenStreetMap's tile address and shows its attribution with the copyright link", () => {
    expect(TILE_URL).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(TILE_ATTRIBUTION).toContain('href="https://www.openstreetmap.org/copyright"');
    expect(read("src/components/map/LeafletMap.tsx")).toContain("attribution: TILE_ATTRIBUTION");
  });

  it("keeps the attribution readable on a solid surface and the zoom buttons 44 px", () => {
    const css = read("src/app/globals.css");
    expect(css).toContain(".map-frame .leaflet-control-attribution { background: var(--surface); color: var(--ink-2);");
    expect(css).toContain(".map-frame .leaflet-bar a { width: 44px; height: 44px;");
    expect(css).not.toMatch(/leaflet-control-attribution[^{]*\{[^}]*display:\s*none/);
  });

  it("blocks the tile and search hosts in every script that drives a browser", () => {
    expect(MAP_HOSTS).toEqual(["tile.openstreetmap.org", "nominatim.openstreetmap.org"]);
    expect(read("scripts/audit-accessibility.ts")).toContain("if (MAP_HOSTS.includes(new URL(route.request().url()).hostname)) return route.abort();");
    const capture = read("scripts/capture-screenshots.ts");
    expect(capture).toContain("await context.route((url) => MAP_HOSTS.includes(url.hostname), (route) => route.abort());");
    expect(capture).not.toContain("browser.newContext({");
    expect(read("scripts/hosted-verify.ts")).toContain("await context.route((url) => MAP_HOSTS.includes(url.hostname), (route) => route.abort());");
  });

  it("sends no Content-Security-Policy or Referrer-Policy that would block tiles, search or the Referer the policies ask for", () => {
    const headers = securityHeaders().flatMap((rule) => rule.headers);
    const csp = headers.find((header) => header.key.toLowerCase() === "content-security-policy");
    if (csp) {
      expect(csp.value).toMatch(/img-src[^;]*tile\.openstreetmap\.org/);
      expect(csp.value).toMatch(/connect-src[^;]*nominatim\.openstreetmap\.org/);
    }
    const referrer = headers.find((header) => header.key.toLowerCase() === "referrer-policy");
    expect(referrer?.value ?? "").not.toBe("no-referrer");
  });
});

describe("the agent sees where they are against the job area, in words", () => {
  const area = { areaName: "Kibuye Market, Kisumu", areaLat: -0.0995, areaLon: 34.768, areaRadiusM: 800 };

  it("says inside, with the fix's accuracy", () => {
    expect(areaStatus(area, { lat: -0.0995, lon: 34.768, accuracy: 12.4 }, false)).toEqual({ kind: "inside", text: "Inside the job area (location accurate to about 12 m)" });
  });

  it("says how far outside, measured as the review screen measures it", () => {
    // 0.01 degrees of latitude is 1.112 km; less the 800 m radius, 312 m outside.
    expect(areaStatus(area, { lat: -0.0895, lon: 34.768, accuracy: null }, false)).toEqual({ kind: "outside", text: "312 m outside the job area" });
    expect(read("src/components/agent/AreaStatus.tsx")).toContain("kmOutsideArea(area, fix.lat, fix.lon)");
  });

  it("says when the location is still being found, or was not found, and offers to try again", () => {
    expect(areaStatus(area, null, true).kind).toBe("locating");
    const missing = renderToStaticMarkup(<AreaStatus area={area} fix={null} locating={false} onRetry={() => {}} />);
    expect(missing).toContain("Your location was not found");
    expect(missing).toContain(">Try again</button>");
    expect(missing).toContain('role="status"');
    expect(renderToStaticMarkup(<AreaStatus area={area} fix={null} locating onRetry={() => {}} />)).not.toContain("<button");
  });

  it("puts the line first and the raw coordinates and simulated device details under Demo controls", () => {
    const form = read("src/components/agent/SubmitActivationForm.tsx");
    expect(form.indexOf("<AreaStatus")).toBeLessThan(form.indexOf("<legend>This activation</legend>"));
    const demo = form.slice(form.indexOf('<details className="demo-controls">'), form.indexOf("</details>"));
    for (const id of ['id="gpsLat"', 'id="gpsLon"', 'id="gpsAccuracyM"', 'id="networkType"', 'id="ipRegion"']) expect(demo).toContain(id);
    expect(form).not.toContain("Captured by your device");
    expect(form).not.toContain("Simulated device details");
  });
});
