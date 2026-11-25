import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { ZodError } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AreaStatus, LocationNeeded, locationBlock } from "@/components/agent/AreaStatus";
import { SubmitActivationForm } from "@/components/agent/SubmitActivationForm";
import { parseSubmissionForm, photoInputs } from "@/lib/activations/submission-form";
import { prisma } from "@/lib/db";
import { currentEvidenceConfig } from "@/lib/evidence/config";
import { PLATFORM_FIELDS } from "@/lib/evidence/platform";
import { ACTIVATION_LOCATION_REQUIRED, OUT_OF_RANGE, PHOTO_LOCATION_INVALID, coordinate } from "@/lib/location";
import { resetDatabase } from "./helpers/db";
import { replyWith, startFakeScoring, type FakeScoring } from "./helpers/fake-scoring";
import { daysFromNow, photo, readyAssignment } from "./helpers/submission";

/**
 * Defect 20: an activation submitted without a location fix was read as
 * latitude 0, longitude 0, stored and scored. The server refuses a blank,
 * missing, non-numeric or exactly 0, 0 location, a photo claiming 0, 0, and the
 * form sends nothing until the device (or the demo button) has a location.
 */
const session = vi.hoisted(() => ({ user: { id: "", name: "", email: "", role: "agent" as const } }));
vi.mock("@/lib/auth/session", () => ({ requireApiRole: vi.fn(async () => session.user) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

const { POST } = await import("@/app/api/agent/activations/route");

const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
const AT = { gpsLat: "-1.283500", gpsLon: "36.833100" };
const CONTEXT = {
  assignmentId: "cmwwfjcij0007o8qwk51tktk7", evidenceConfigId: "cmwwfjcij0007o8qwk51tktk8", gpsAccuracyM: "8",
  deviceId: "device-test-1", deviceOs: "android", appVersion: "web-0.1.0", networkType: "cellular", ipRegion: "",
};

/** The submission's context as the form posts it; an undefined value leaves the field out. */
function formWith(fields: Record<string, string | undefined>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...CONTEXT, ...fields })) if (value !== undefined) form.set(key, value);
  return form;
}

function issuesOf(run: () => unknown): string[] {
  try {
    run();
    return [];
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).sort();
  }
}

const BOTH = [`gpsLat: ${ACTIVATION_LOCATION_REQUIRED}`, `gpsLon: ${ACTIVATION_LOCATION_REQUIRED}`];

describe("the server refuses an activation with no location (defect 20)", () => {
  const cases: Array<[string, string | undefined]> = [["blank", ""], ["spaces", "  "], ["missing", undefined], ["text", "here"], ["not a number", "NaN"]];
  for (const [name, value] of cases) {
    it(`refuses ${name} coordinates, naming each field`, () => {
      expect(issuesOf(() => parseSubmissionForm(formWith({ gpsLat: value, gpsLon: value }), "agent1"))).toEqual(BOTH);
    });
  }

  it("refuses exactly 0, 0", () => {
    for (const zero of ["0", "0.000000", "-0"]) expect(issuesOf(() => parseSubmissionForm(formWith({ gpsLat: zero, gpsLon: zero }), "agent1"))).toEqual(BOTH);
  });

  it("names the one coordinate that is missing, and refuses one off the globe", () => {
    expect(issuesOf(() => parseSubmissionForm(formWith({ gpsLat: "", gpsLon: "36.8" }), "agent1"))).toEqual([BOTH[0]]);
    expect(issuesOf(() => parseSubmissionForm(formWith({ gpsLat: "95", gpsLon: "36.8" }), "agent1"))).toEqual([`gpsLat: ${OUT_OF_RANGE}`]);
  });

  it("accepts a device fix, and one on the equator", () => {
    expect(parseSubmissionForm(formWith(AT), "agent1")).toMatchObject({ gpsLat: -1.2835, gpsLon: 36.8331, gpsAccuracyM: 8 });
    expect(parseSubmissionForm(formWith({ gpsLat: "0", gpsLon: "34.75" }), "agent1")).toMatchObject({ gpsLat: 0, gpsLon: 34.75 });
  });
});

describe("a photo may have no location, but not one at 0, 0 (defect 20)", () => {
  const withPhoto = (meta: Record<string, unknown>, prefix = "field_1") => {
    const form = formWith(AT);
    const [files, metaName] = prefix ? [`photos:${prefix}`, `photoMeta:${prefix}`] : ["photos", "photoMeta"];
    form.append(files, photo("a.png"));
    form.set(metaName, JSON.stringify([{ locationSource: "device", ...meta }]));
    return form;
  };

  it("refuses 0, 0, naming the photo", () => {
    expect(issuesOf(() => parseSubmissionForm(withPhoto({ gpsLat: 0, gpsLon: 0 }), "agent1"))).toEqual([`photoMeta:field_1.0.gpsLat: ${PHOTO_LOCATION_INVALID}`]);
  });

  it("refuses it on the photos of an evidence-request reply too", () => {
    expect(issuesOf(() => photoInputs(withPhoto({ gpsLat: 0, gpsLon: 0 }, "")))).toEqual([`photoMeta.0.gpsLat: ${PHOTO_LOCATION_INVALID}`]);
  });

  it("keeps a photo with no location, and one with a real place", () => {
    expect(parseSubmissionForm(withPhoto({ gpsLat: null, gpsLon: null, locationSource: "none" }), "agent1").photos.field_1[0]).toMatchObject({ gpsLat: null, gpsLon: null, locationSource: "none" });
    expect(parseSubmissionForm(withPhoto({ gpsLat: -1.29, gpsLon: 36.84 }), "agent1").photos.field_1[0]).toMatchObject({ gpsLat: -1.29, gpsLon: 36.84, locationSource: "device" });
  });
});

describe("a direct API call cannot store an activation without a location (defect 20)", () => {
  let scoring: FakeScoring;
  beforeAll(async () => {
    scoring = await startFakeScoring(replyWith("review", 0.4));
    process.env.SCORING_SERVICE_URL = scoring.url;
  });
  afterAll(() => scoring.close());
  beforeEach(resetDatabase);

  async function submission(location: Record<string, string>) {
    const assignment = await readyAssignment();
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: assignment.agentId } });
    session.user = { id: agent.userId, name: "Agent", email: "a@test.local", role: "agent" };
    const config = await currentEvidenceConfig(prisma, assignment.jobId);
    const form = formWith({ ...location, assignmentId: assignment.id, evidenceConfigId: config.id });
    form.set("field:customerMsisdn", "0711222333");
    form.set("field:simRegisteredAt", daysFromNow(-20));
    form.set("field:activationMethod", "qr_scan");
    form.append("photos:field_1", photo("a.png"));
    form.set("photoMeta:field_1", JSON.stringify([{ capturedAt: new Date().toISOString(), gpsLat: null, gpsLon: null, locationSource: "none" }]));
    return new NextRequest("http://localhost/api/agent/activations", { method: "POST", body: form });
  }
  const context = { params: Promise.resolve({}) };

  it("answers 422 with the field error and stores and scores nothing", async () => {
    for (const location of [{ gpsLat: "", gpsLon: "" }, { gpsLat: "0", gpsLon: "0" }, {}] as Array<Record<string, string>>) {
      await resetDatabase();
      const response = await POST(await submission(location), context);
      const body = (await response.json()) as { error: { code: string; details: Array<{ path: string; message: string }> } };
      expect(response.status).toBe(422);
      expect(body.error.details).toContainEqual({ path: "gpsLat", message: ACTIVATION_LOCATION_REQUIRED });
      expect([await prisma.activation.count(), await prisma.evidenceItem.count(), await prisma.scoringDecision.count()]).toEqual([0, 0, 0]);
    }
  });

  it("stores the job area centre the demo button sends", async () => {
    const response = await POST(await submission({ gpsLat: coordinate(-1.2833), gpsLon: coordinate(36.8333) }), context);
    expect(response.status).toBe(201);
    expect(await prisma.activation.findFirstOrThrow()).toMatchObject({ gpsLat: -1.2833, gpsLon: 36.8333 });
  });
});

describe("the activation form sends nothing without a location (defect 20)", () => {
  const area = { areaName: "Kibuye Market", areaLat: -0.0995, areaLon: 34.768, areaRadiusM: 800 };

  it("blocks on blank or 0, 0 coordinates, and says to turn location on", () => {
    expect(locationBlock("", "", false)).toBe(ACTIVATION_LOCATION_REQUIRED);
    expect(locationBlock("0.000000", "0.000000", false)).toBe(ACTIVATION_LOCATION_REQUIRED);
    expect(locationBlock("", "", true)).toBe("Still finding your location. Wait a moment, then submit again.");
    expect(ACTIVATION_LOCATION_REQUIRED).toContain("Turn on location and try again.");
    expect(locationBlock(AT.gpsLat, AT.gpsLon, false)).toBeNull();
  });

  it("shows the message with Try again beside the button", () => {
    const html = renderToStaticMarkup(<LocationNeeded message={ACTIVATION_LOCATION_REQUIRED} locating={false} onRetry={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(ACTIVATION_LOCATION_REQUIRED);
    expect(html).toMatch(/<button type="button" class="btn small">Try again<\/button>/);
    expect(renderToStaticMarkup(<LocationNeeded message="Still finding" locating onRetry={() => {}} />)).toContain("disabled");
  });

  it("says it in the status line at the top too", () => {
    const html = renderToStaticMarkup(<AreaStatus area={area} fix={null} locating={false} onRetry={() => {}} />);
    expect(html).toContain("Your location was not found");
    expect(html).toContain("Turn on location and try again.");
    expect(html).toContain(">Try again</button>");
  });

  it("checks before anything is posted, and ignores a device reading of 0, 0", () => {
    const source = read("src/components/agent/SubmitActivationForm.tsx");
    expect(source.indexOf("if (local || noLocation) return;")).toBeGreaterThan(-1);
    expect(source.indexOf("if (local || noLocation) return;")).toBeLessThan(source.indexOf('postForm<{ activationId: string }>("/api/agent/activations"'));
    expect(source).toContain("if (locationMissing(next.lat, next.lon)) return setLocating(false);");
    expect(source).toContain("<LocationNeeded message={blocked} locating={locating} onRetry={relocate} />");
  });

  it("offers no way to type a location: the demo boxes are read-only and the job-centre button stays", () => {
    const html = renderToStaticMarkup(<SubmitActivationForm assignmentId="a1" job={{ title: "Job", ...area }} regions={[]} platformFields={PLATFORM_FIELDS} jobFields={[]} evidenceConfigId="c1" configVersion={1} />);
    for (const id of ["gpsLat", "gpsLon", "gpsAccuracyM"]) {
      expect(html.match(new RegExp(`<input id="${id}"[^>]*/>`))?.[0]).toContain('readOnly=""');
    }
    expect(html).toContain("Use the job area centre as my location (demo)");
    expect(html).not.toContain("Enter coordinates yourself");
    const source = read("src/components/agent/SubmitActivationForm.tsx");
    expect(source).not.toMatch(/ManualToggle|ManualCoordinates/);
    expect(source).not.toMatch(/setCoords\(\{ \.\.\.coords/);
    expect(source).toContain("applyFix({ lat: job.areaLat, lon: job.areaLon, accuracy: 10 })");
  });
});
