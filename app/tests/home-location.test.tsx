import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignupForm } from "@/app/signup/SignupForm";
import { HomeBasePicker, chosenText } from "@/components/HomeBasePicker";
import { formProblems } from "@/components/client/PostJobForm";
import { signupSchema } from "@/lib/auth/signup";
import { browserSignupProblems } from "@/lib/auth/signup-checks";
import { prisma } from "@/lib/db";
import { jobInputSchema } from "@/lib/jobs/jobs";
import { HOME_LOCATION_REQUIRED, JOB_LOCATION_REQUIRED, coordinateValue, locationMissing } from "@/lib/location";
import { resetDatabase } from "./helpers/db";
import { createClient } from "./helpers/factories";
import { fundEscrow } from "./helpers/funding";

/**
 * Defect 19: a blank location was read as latitude 0, longitude 0, so an
 * agent's base or a job's centre could be stored nowhere. Both schemas and
 * both forms refuse it. And the sign-up form's base location is chosen by
 * place search or the device's location instead of typed coordinates.
 */
const session = vi.hoisted(() => ({ user: { id: "", name: "", email: "", role: "client" as const } }));
vi.mock("@/lib/auth/session", () => ({ requireApiRole: vi.fn(async () => session.user) }));
// The forms use the app router; rendering them here needs only a stand-in.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }) }));

const { POST: postSignup } = await import("@/app/api/auth/signup/route");
const { POST: postJob } = await import("@/app/api/client/jobs/route");

const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");

const AGENT = { role: "agent", name: "Grace Wanjiku", email: "grace@example.com", password: "Long-Password-42", payoutMsisdn: "0712 345 678", homeAreaName: "Kariobangi" };
const PLACED = { homeLat: "-1.250000", homeLon: "36.880000" };
const JOB = {
  title: "Wallet activations", description: "Sign customers up for the wallet.", areaName: "Kibuye Market", areaRadiusM: "700",
  submissionValueCents: 100_000, commissionRateBps: 1000, flatCommissionCents: 0, slots: "1", deadline: "2027-06-30",
};
const AT = { areaLat: "-0.099500", areaLon: "34.768000" };

/** Every way a coordinate can fail to be a place's. */
const NOT_COORDINATES: Array<[string, unknown]> = [["blank", ""], ["spaces", "   "], ["null", null], ["missing", undefined], ["text", "here"], ["an empty list", []], ["true", true]];

function issuesAt(result: { success: boolean; error?: { issues: Array<{ path: (string | number)[]; message: string }> } }) {
  return (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`).sort();
}

const request = (url: string, body: unknown) => new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const context = { params: Promise.resolve({}) };

describe("what counts as a chosen location", () => {
  it("reads numbers and numeric text, and nothing else", () => {
    expect([coordinateValue("-1.25"), coordinateValue(36.88), coordinateValue("0")]).toEqual([-1.25, 36.88, 0]);
    for (const [name, value] of NOT_COORDINATES) expect(coordinateValue(value), name).toBeUndefined();
    expect(coordinateValue(Number.NaN)).toBeUndefined();
  });

  it("is missing when either value is, or both are exactly zero, but not when one is", () => {
    expect(locationMissing("", "36.88")).toBe(true);
    expect(locationMissing("-1.25", "")).toBe(true);
    expect(locationMissing(0, 0)).toBe(true);
    expect(locationMissing("0.000000", "-0")).toBe(true);
    expect(locationMissing(0, 34.7)).toBe(false);
    expect(locationMissing(-1.25, 0)).toBe(false);
  });
});

describe("the sign-up schema refuses an agent with no base (defect 19)", () => {
  for (const [name, value] of NOT_COORDINATES) {
    it(`refuses ${name} coordinates, naming each field`, () => {
      const result = signupSchema.safeParse({ ...AGENT, homeLat: value, homeLon: value });
      expect(result.success).toBe(false);
      expect(issuesAt(result)).toEqual([`homeLat: ${HOME_LOCATION_REQUIRED}`, `homeLon: ${HOME_LOCATION_REQUIRED}`]);
    });
  }

  it("refuses exactly 0, 0, as numbers or text", () => {
    for (const zero of [0, "0", "0.000000"]) {
      const result = signupSchema.safeParse({ ...AGENT, homeLat: zero, homeLon: zero });
      expect(issuesAt(result)).toEqual([`homeLat: ${HOME_LOCATION_REQUIRED}`, `homeLon: ${HOME_LOCATION_REQUIRED}`]);
    }
  });

  it("accepts a real place, as the form sends it, and a place on the equator", () => {
    expect(signupSchema.parse({ ...AGENT, ...PLACED })).toMatchObject({ homeLat: -1.25, homeLon: 36.88 });
    expect(signupSchema.safeParse({ ...AGENT, homeLat: "0", homeLon: "34.75" }).success).toBe(true);
    expect(signupSchema.safeParse({ ...AGENT, homeLat: "95", homeLon: "36.88" }).success).toBe(false);
  });

  it("asks a client business for no location", () => {
    expect(signupSchema.safeParse({ role: "client", name: "Owner", email: "o@biz.co.ke", password: "Long-Password-42", businessName: "Duka" }).success).toBe(true);
  });
});

describe("the job schema refuses a job with no area (defect 19)", () => {
  for (const [name, value] of NOT_COORDINATES) {
    it(`refuses ${name} coordinates, naming each field`, () => {
      const result = jobInputSchema.safeParse({ ...JOB, areaLat: value, areaLon: value });
      expect(result.success).toBe(false);
      expect(issuesAt(result)).toEqual([`areaLat: ${JOB_LOCATION_REQUIRED}`, `areaLon: ${JOB_LOCATION_REQUIRED}`]);
    });
  }

  it("refuses exactly 0, 0 and accepts a real centre", () => {
    expect(issuesAt(jobInputSchema.safeParse({ ...JOB, areaLat: 0, areaLon: "0" }))).toEqual([`areaLat: ${JOB_LOCATION_REQUIRED}`, `areaLon: ${JOB_LOCATION_REQUIRED}`]);
    expect(jobInputSchema.parse({ ...JOB, ...AT })).toMatchObject({ areaLat: -0.0995, areaLon: 34.768 });
    expect(jobInputSchema.safeParse({ ...JOB, areaLat: "0", areaLon: "34.75" }).success).toBe(true);
  });
});

describe("a direct API call cannot store a missing location (defect 19)", () => {
  beforeEach(resetDatabase);

  it("answers 422 with the field error at sign-up and creates no account", async () => {
    for (const location of [{ homeLat: "", homeLon: "" }, {}, { homeLat: 0, homeLon: 0 }]) {
      const response = await postSignup(request("http://localhost/api/auth/signup", { ...AGENT, ...location }), context);
      const body = (await response.json()) as { error: { code: string; details: Array<{ path: string; message: string }> } };
      expect(response.status).toBe(422);
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details).toContainEqual({ path: "homeLat", message: HOME_LOCATION_REQUIRED });
    }
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.agent.count()).toBe(0);
  });

  it("still creates an agent with a real base", async () => {
    const response = await postSignup(request("http://localhost/api/auth/signup", { ...AGENT, ...PLACED }), context);
    expect(response.status).toBe(201);
    expect(await prisma.agent.findFirstOrThrow()).toMatchObject({ homeLat: -1.25, homeLon: 36.88, homeAreaName: "Kariobangi" });
  });

  it("answers 422 with the field error for a job, creates none and locks nothing", async () => {
    const client = await createClient();
    await fundEscrow({ clientId: client.id, amountCents: 100_000, actorId: client.userId });
    session.user = { id: client.userId, name: "Owner", email: "o@test.local", role: "client" };
    for (const location of [{ areaLat: "", areaLon: "" }, {}, { areaLat: 0, areaLon: 0 }]) {
      const response = await postJob(request("http://localhost/api/client/jobs", { ...JOB, ...location }), context);
      const body = (await response.json()) as { error: { details: Array<{ path: string; message: string }> } };
      expect(response.status).toBe(422);
      expect(body.error.details).toContainEqual({ path: "areaLat", message: JOB_LOCATION_REQUIRED });
    }
    expect(await prisma.job.count()).toBe(0);
    expect((await postJob(request("http://localhost/api/client/jobs", { ...JOB, ...AT }), context)).status).toBe(201);
    expect(await prisma.job.findFirstOrThrow()).toMatchObject({ areaLat: -0.0995, areaLon: 34.768 });
  });
});

describe("the sign-up form does not send an agent without a base (defect 19)", () => {
  const passwords = { password: "Long-Password-42", confirmation: "Long-Password-42" };

  it("stops with the message beside the location", () => {
    const blocked = browserSignupProblems({ role: "agent", ...passwords, homeLat: "", homeLon: "" });
    expect(blocked).toEqual({ errors: { homeLat: HOME_LOCATION_REQUIRED }, message: HOME_LOCATION_REQUIRED });
    expect(browserSignupProblems({ role: "agent", ...passwords, homeLat: "0", homeLon: "0" })?.errors.homeLat).toBe(HOME_LOCATION_REQUIRED);
  });

  it("sends when a base is chosen, and asks a client business for none", () => {
    expect(browserSignupProblems({ role: "agent", ...passwords, ...PLACED })).toBeNull();
    expect(browserSignupProblems({ role: "client", ...passwords, homeLat: null, homeLon: null })).toBeNull();
  });

  it("keeps the password message, and says both when both are wrong", () => {
    const weak = { password: "short", confirmation: "short" };
    expect(browserSignupProblems({ role: "client", ...weak, homeLat: null, homeLon: null })?.message).toBe("Check the password fields below.");
    const both = browserSignupProblems({ role: "agent", ...weak, homeLat: "", homeLon: "" });
    expect(both?.message).toBe("Check the password fields, and choose where you are based.");
    expect(Object.keys(both!.errors).sort()).toEqual(["homeLat", "password"]);
    expect(browserSignupProblems({ role: "agent", password: "Long-Password-42", confirmation: "Long-Password-43", ...PLACED })?.message).toBe("Check the password fields below.");
  });

  it("checks before anything is sent", () => {
    const source = read("src/app/signup/SignupForm.tsx");
    expect(source.indexOf("browserSignupProblems({")).toBeLessThan(source.indexOf('postJson<{ id: string }>("/api/auth/signup"'));
    expect(source).toMatch(/if \(blocked\) \{[^}]*return;\s*\}/);
  });
});

describe("the post-a-job form does not send a job without an area (defect 19)", () => {
  const terms = { value: "1000", rate: "10", flat: "", slots: "1" };

  it("stops with the message when no pin is placed", () => {
    expect(formProblems(terms, { lat: "", lon: "" })).toEqual({ parsed: null, errors: { areaLat: JOB_LOCATION_REQUIRED }, message: JOB_LOCATION_REQUIRED });
    expect(formProblems(terms, { lat: "0.000000", lon: "0.000000" }).parsed).toBeNull();
  });

  it("reports the area together with bad terms", () => {
    const result = formProblems({ ...terms, value: "" }, { lat: "", lon: "" });
    expect(result.message).toBe("Some fields are missing or invalid.");
    expect(Object.keys(result.errors).sort()).toEqual(["areaLat", "submissionValueKsh"]);
  });

  it("sends when the terms parse and the area is placed", () => {
    const result = formProblems(terms, { lat: AT.areaLat, lon: AT.areaLon });
    expect(result.message).toBeNull();
    expect(result.parsed).toMatchObject({ submissionValueCents: 100_000, slots: 1 });
  });

  it("checks before anything is sent", () => {
    const source = read("src/components/client/PostJobForm.tsx");
    expect(source.indexOf("= formProblems(terms,")).toBeGreaterThan(-1);
    expect(source.indexOf("= formProblems(terms,")).toBeLessThan(source.indexOf('postJson<{ jobId: string }>("/api/client/jobs"'));
  });
});

describe("sign-up's base location: place search or the device, no map", () => {
  const html = renderToStaticMarkup(<HomeBasePicker errors={{}} />);
  const tag = (markup: string, id: string) => markup.match(new RegExp(`<input id="${id}"[^>]*/>`))?.[0] ?? "";

  it("offers the search, the device's location and an editable area name, and says nothing is chosen", () => {
    expect(html).toContain('id="homeSearch" type="search"');
    expect(html).toContain("Use my location");
    expect(html).toContain("No location chosen yet.");
    expect(tag(html, "homeAreaName")).toContain('name="homeAreaName"');
    expect(tag(html, "homeAreaName")).not.toContain("readOnly");
    expect(html).not.toContain("map-canvas");
  });

  it("shows latitude and longitude read-only under Advanced, empty until a place is chosen", () => {
    expect(html).toMatch(/<details class="help-more"><summary class="small">Advanced: the values sent<\/summary>/);
    for (const id of ["homeLat", "homeLon"]) {
      expect(tag(html, id)).toContain(`name="${id}"`);
      expect(tag(html, id)).toContain('readOnly=""');
      expect(tag(html, id)).toContain('value=""');
    }
  });

  it("names the chosen place", () => {
    expect(chosenText(null)).toBe("No location chosen yet.");
    expect(chosenText({ lat: -1.25, lon: 36.88, name: "Kariobangi North, Nairobi, Kenya" })).toBe("Chosen: Kariobangi North, Nairobi, Kenya");
    expect(chosenText({ lat: -1.25, lon: 36.88, name: null })).toBe("Chosen: your current location.");
  });

  it("shows a location error where it can be seen, outside Advanced", () => {
    const failed = renderToStaticMarkup(<HomeBasePicker errors={{ homeLat: HOME_LOCATION_REQUIRED }} />);
    expect(failed).toContain(`<span class="field-error" role="alert">${HOME_LOCATION_REQUIRED}</span>`);
    expect(failed.indexOf("field-error")).toBeLessThan(failed.indexOf("<details"));
  });

  it("is the agent sign-up form's location, sending the same three fields", () => {
    const form = renderToStaticMarkup(<SignupForm />);
    for (const name of ["homeAreaName", "homeLat", "homeLon", "payoutMsisdn"]) expect(form).toContain(`name="${name}"`);
    expect(form).toContain("Search for your area");
    expect(form.match(/>Where you are based</g)).toHaveLength(1);
    expect(form).not.toMatch(/Find where you are based/);
    expect(form).not.toContain("Use my current location");
    const source = read("src/app/signup/SignupForm.tsx");
    for (const field of ['homeAreaName: form.get("homeAreaName")', 'homeLat: form.get("homeLat")', 'homeLon: form.get("homeLon")']) expect(source).toContain(field);
  });

  it("searches only on Enter or the button, through the policy-keeping geocoder, and loads no map", () => {
    const source = read("src/components/HomeBasePicker.tsx");
    expect(source.match(/void runSearch\(\)/g)).toHaveLength(2);
    expect(source).toContain('if (event.key !== "Enter") return;');
    expect(source).toContain("createGeocoder(GEOCODER_URL)");
    expect(source).not.toMatch(/leaflet|LeafletMap|fetch\(/i);
  });
});
