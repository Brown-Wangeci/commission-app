import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HomeBasePicker, chosenText } from "@/components/HomeBasePicker";
import { ManualToggle, OUTSIDE_KENYA_WARNING, TypedNotes } from "@/components/ManualCoordinates";
import { JobAreaPicker } from "@/components/client/JobAreaPicker";
import { formProblems } from "@/components/client/PostJobForm";
import { signupSchema } from "@/lib/auth/signup";
import { browserSignupProblems } from "@/lib/auth/signup-checks";
import { REGIONS } from "@/lib/geo";
import { jobInputSchema } from "@/lib/jobs/jobs";
import { HOME_LOCATION_REQUIRED, JOB_LOCATION_REQUIRED, KENYA_BOUNDS, OUT_OF_RANGE, outsideKenya, typedLocationProblem, validPoint, wrapLongitude } from "@/lib/location";
import { RADIUS_PROBLEM, RADIUS_STEPS_M, circleBounds, exactRadiusLabel, validRadius } from "@/lib/map/radius";

/**
 * "Enter coordinates yourself": a secondary option under Advanced on sign-up
 * and Post a job, for rare cases. Typed values meet the same rules as chosen
 * ones; outside Kenya they raise a warning and are still accepted.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }) }));

const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
const LONDON = { lat: 51.5, lon: -0.12 };

describe("typed coordinates meet the same rules as chosen ones", () => {
  it("says what is wrong while typing, and nothing before anything is typed", () => {
    expect(typedLocationProblem("", "")).toBeNull();
    expect(typedLocationProblem("-1.2921", "36.8219")).toBeNull();
    expect(typedLocationProblem("-1,29", "36.8")).toBe("Enter numbers only, with a dot for decimals, for example -1.2921 and 36.8219.");
    expect(typedLocationProblem("-", "")).toContain("Enter numbers only");
    expect(typedLocationProblem("-1.29", "")).toBe("Enter both latitude and longitude.");
    expect(typedLocationProblem("0", "0.0")).toBe("Latitude 0, longitude 0 is not a real place.");
    expect(typedLocationProblem("91", "36.8")).toBe(OUT_OF_RANGE);
    expect(typedLocationProblem("-1.29", "181")).toBe(OUT_OF_RANGE);
  });

  it("gives a point only when the server would accept it", () => {
    expect(validPoint("-1.2921", "36.8219")).toEqual({ lat: -1.2921, lon: 36.8219 });
    for (const [lat, lon] of [["", ""], ["x", "1"], ["0", "0"], ["90.1", "0"], ["1", "-180.1"]]) expect(validPoint(lat, lon)).toBeNull();
    expect(validPoint("0", "34.75")).not.toBeNull();
  });

  it("takes the radius the server takes: whole metres from 50 m to 50 km", () => {
    const schema = jobInputSchema.innerType().shape.areaRadiusM;
    for (const text of ["50", "700", "1234", "50000"]) expect(validRadius(text)).toBe(Number(text));
    for (const text of ["49", "50001", "700.5", "", "far"]) {
      expect(validRadius(text)).toBeNull();
      expect(schema.safeParse(text).success, text).toBe(false);
    }
    expect([exactRadiusLabel(700), exactRadiusLabel(1234), exactRadiusLabel(1500)]).toEqual(["700 m", "1234 m", "1.5 km"]);
  });

  it("stops Post a job on a typed value the server would refuse", () => {
    const terms = { value: "1000", rate: "10", flat: "", slots: "1" };
    expect(formProblems(terms, { lat: "95", lon: "36.8", radius: "700" })).toMatchObject({ parsed: null, errors: { areaLat: OUT_OF_RANGE }, message: OUT_OF_RANGE });
    expect(formProblems(terms, { lat: "abc", lon: "36.8", radius: "700" }).errors.areaLat).toBe(JOB_LOCATION_REQUIRED);
    expect(formProblems(terms, { lat: "-1.29", lon: "36.8", radius: "20" })).toMatchObject({ parsed: null, errors: { areaRadiusM: RADIUS_PROBLEM }, message: RADIUS_PROBLEM });
    expect(formProblems(terms, { lat: "-1.29", lon: "36.8", radius: "850" }).message).toBeNull();
  });

  it("stops sign-up on typed coordinates off the globe", () => {
    const ok = { role: "agent" as const, password: "Long-Password-42", confirmation: "Long-Password-42" };
    expect(browserSignupProblems({ ...ok, homeLat: "-1.29", homeLon: "200" })).toEqual({ errors: { homeLat: OUT_OF_RANGE }, message: OUT_OF_RANGE });
    expect(browserSignupProblems({ ...ok, homeLat: "north", homeLon: "36.8" })?.message).toBe(HOME_LOCATION_REQUIRED);
  });
});

describe("outside Kenya is a warning, never a refusal", () => {
  it("knows the model's four cities are inside, and the edges count as inside", () => {
    for (const region of REGIONS) expect(outsideKenya(region), region.name).toBe(false);
    expect(outsideKenya({ lat: KENYA_BOUNDS.north, lon: KENYA_BOUNDS.east })).toBe(false);
    expect(outsideKenya({ lat: KENYA_BOUNDS.south, lon: KENYA_BOUNDS.west })).toBe(false);
  });

  it("warns for places beyond the rectangle, including swapped coordinates", () => {
    expect(outsideKenya(LONDON)).toBe(true);
    expect(outsideKenya({ lat: 36.8219, lon: -1.2921 })).toBe(true);
    expect(outsideKenya({ lat: -6.8, lon: 39.28 })).toBe(true);
    expect(outsideKenya({ lat: 0.35, lon: 32.58 })).toBe(true);
  });

  it("shows the warning, or the problem, or nothing", () => {
    expect(renderToStaticMarkup(<TypedNotes lat="51.5" lon="-0.12" />)).toBe(`<div class="alert warn" role="status">${OUTSIDE_KENYA_WARNING}</div>`);
    expect(renderToStaticMarkup(<TypedNotes lat="0" lon="0" />)).toContain('class="field-error"');
    expect(renderToStaticMarkup(<TypedNotes lat="-1.29" lon="36.82" />)).toBe("");
    expect(renderToStaticMarkup(<TypedNotes lat="" lon="" />)).toBe("");
  });

  it("is accepted by both schemas and both browser checks", () => {
    const agent = { role: "agent", name: "Far Agent", email: "far@example.com", password: "Long-Password-42", payoutMsisdn: "0712345678", homeAreaName: "London", homeLat: "51.5", homeLon: "-0.12" };
    expect(signupSchema.safeParse(agent).success).toBe(true);
    expect(browserSignupProblems({ role: "agent", password: "Long-Password-42", confirmation: "Long-Password-42", homeLat: "51.5", homeLon: "-0.12" })).toBeNull();
    expect(formProblems({ value: "1000", rate: "10", flat: "", slots: "1" }, { lat: "51.5", lon: "-0.12", radius: "700" }).message).toBeNull();
  });
});

describe("the option is secondary: collapsed, off by default and labelled for rare cases", () => {
  const home = renderToStaticMarkup(<HomeBasePicker errors={{}} />);
  const job = renderToStaticMarkup(<JobAreaPicker errors={{}} defaultRadiusM={700} />);

  it("is an unticked box inside the closed Advanced section of both forms", () => {
    expect(renderToStaticMarkup(<ManualToggle checked={false} onChange={() => {}} without="search" />)).toContain("For rare cases only, when search cannot give the right point.");
    for (const html of [home, job]) {
      const advanced = html.slice(html.indexOf('<details class="help-more">'));
      expect(advanced).toMatch(/<label class="manual-toggle"><input type="checkbox"\/>Enter coordinates yourself<\/label>/);
      expect(advanced).toContain("For rare cases only");
      expect(html).not.toMatch(/<details class="help-more" open/);
      expect(html.indexOf("Enter coordinates yourself")).toBeGreaterThan(html.indexOf("Use my location"));
    }
  });

  it("leaves every coordinate and the radius read-only until it is ticked", () => {
    for (const [html, ids] of [[home, ["homeLat", "homeLon"]], [job, ["areaLat", "areaLon", "areaRadiusM"]]] as const) {
      for (const id of ids) expect(html.match(new RegExp(`<input id="${id}"[^>]*/>`))?.[0]).toContain('readOnly=""');
    }
    for (const [file, ids] of [["src/components/HomeBasePicker.tsx", ["homeLat", "homeLon"]], ["src/components/client/JobAreaPicker.tsx", ["areaLat", "areaLon", "areaRadiusM"]]] as const) {
      const source = read(file);
      for (const id of ids) expect(source).toMatch(new RegExp(`<input id="${id}"[^\\n]*readOnly=\\{!manual\\}[^\\n]*onChange=`));
    }
  });

  it("says when the chosen point was typed", () => {
    expect(chosenText({ lat: -1.29, lon: 36.82, name: null, typed: true })).toBe("Chosen: the coordinates you entered.");
  });
});

describe("the map stays under the sticky bars (defect 22)", () => {
  it("keeps Leaflet's stacking inside the map's frame, below the top bar and the Publish bar", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/\.map-frame \{ isolation: isolate;/);
    expect(css).toMatch(/\.topnav \{[^}]*position: sticky;[^}]*z-index: 10;/);
    expect(css).toMatch(/\.post-summary \{ position: sticky; top: auto; bottom: 0; z-index: 5;/);
  });

  it("gives the top navigation links at least 24 px on a phone, found by the audit once the page was scrolled", () => {
    expect(read("src/app/globals.css")).toMatch(/@media \(max-width: 640px\) \{[\s\S]*?\.navlink \{ min-height: 24px; \}/);
  });
});

describe("the map's pin and circle follow typed values", () => {
  const source = read("src/components/client/JobAreaPicker.tsx");

  it("reads the pin and the circle from the same fields the form sends", () => {
    expect(source).toContain("const pin = validPoint(text.lat, text.lon);");
    expect(source).toContain("const radius = validRadius(radiusText);");
    expect(source).toContain("<LeafletMap pin={pin} radiusM={radius ?? 0} onPick={place}");
    expect(source).toContain("value={radiusText}");
  });

  it("moves the map to a typed circle once the field is left", () => {
    expect(source.match(/onBlur=\{showTyped\}/g)).toHaveLength(3);
    expect(source).toContain("moveTo({ bounds: circleBounds(pin, radius) })");
    const [south, north, west, east] = circleBounds({ lat: -0.0995, lon: 34.768 }, 1000);
    // 1 km is about 0.009 degrees at the equator.
    expect(north - south).toBeCloseTo(0.018, 3);
    expect(east - west).toBeCloseTo(0.018, 3);
    expect((north + south) / 2).toBeCloseTo(-0.0995, 6);
    const [s, n] = circleBounds({ lat: 0.5, lon: 35 }, RADIUS_STEPS_M[0]);
    expect(n - s).toBeGreaterThan(0.005);
  });

  it("draws the pin on its point: nothing turns the element Leaflet positions (defect 21)", () => {
    const css = read("src/app/globals.css");
    const pin = css.match(/\.map-frame \.map-pin \{([^}]*)\}/)?.[1] ?? "";
    expect(pin).not.toBe("");
    expect(pin).not.toMatch(/rotate|transform|translate|scale/);
    expect(css).toMatch(/\.map-frame \.map-pin::before \{[^}]*position: absolute; inset: 0;[^}]*transform: rotate\(-45deg\);/);
    // A 28 px square turned 45 degrees ends 14 * (1 + sqrt 2), about 34 px, below its top: the anchor.
    expect(read("src/components/map/LeafletMap.tsx")).toContain("iconSize: [28, 28], iconAnchor: [14, 34]");
  });

  it("does not refit the map for a radius that is not usable yet, and brings a wrapped longitude back", () => {
    expect(read("src/components/map/LeafletMap.tsx")).toContain("if (!ready || !m || !circle.current || radiusM <= 0) return;");
    expect(wrapLongitude(394.768)).toBeCloseTo(34.768, 9);
    expect(wrapLongitude(-325.232)).toBeCloseTo(34.768, 9);
    expect(wrapLongitude(34.768)).toBe(34.768);
    expect(wrapLongitude(180)).toBe(180);
  });
});
