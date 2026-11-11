/**
 * NFR-12: measures, with Playwright at 360 px wide, the rendered width and
 * height of every interactive control on the agent job list and the agent
 * submission form, and whether either page scrolls sideways. Writes
 * docs/chapter5/evidence/nfr12-touch-targets.json.
 *
 * So that the job list shows both of its control types, the script first
 * makes two assignments for Mercy through the app's own API (client2 posts
 * two small jobs, an administrator assigns both): one is left waiting to be
 * accepted, the other is accepted, so the list carries an "Accept job"
 * button and a "Submit activation" link. The submission form is the accepted
 * one's, with the "Simulated device details" section opened so the controls
 * inside it are measured too.
 *
 * Usage: npx tsx scripts/measure-touch-targets.ts [out_file]
 * Prerequisites: the app running against a seeded database (APP_URL,
 * default http://localhost:3000). It adds two jobs, so run it after any
 * screenshot capture that should show the seed exactly.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { APP, call, DAY, DEMO_EVIDENCE_FIELDS, nairobiDate, signIn } from "./demo-client";
import { loadEnv } from "./load-env";

loadEnv();

const WIDTH = 360;
const HEIGHT = 800;
const MINIMUM = 48;
const AGENT_EMAIL = "mercy@ledgerfield.test";
const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';

type Control = { tag: string; type: string | null; name: string; width: number; height: number; meets: boolean };

async function assignTwo(): Promise<{ waiting: string; accepted: string }> {
  const admin = await signIn("reviewer@ledgerfield.test");
  const client = await signIn("client2@ledgerfield.test");
  const agent = await signIn(AGENT_EMAIL);
  const { agents } = await call<{ agents: Array<{ id: string; email: string }> }>(admin, "GET", "/api/admin/agents");
  const mercy = agents.find((a) => a.email === AGENT_EMAIL);
  if (!mercy) throw new Error(`${AGENT_EMAIL} not found; seed the database first.`);
  const ids: string[] = [];
  for (const suffix of ["A", "B"]) {
    const { jobId } = await call<{ jobId: string }>(client, "POST", "/api/client/jobs", {
      title: `Wallet activations, Kibuye Market (touch-target check ${suffix})`,
      description: "Sign up new wallet customers in person at the market.",
      areaName: "Kibuye Market, Kisumu", areaLat: -0.0995, areaLon: 34.768, areaRadiusM: 800,
      submissionValueCents: 10_000, commissionRateBps: 1000, flatCommissionCents: 0, slots: 1,
      deadline: nairobiDate(new Date(Date.now() + 30 * DAY)), evidenceFields: DEMO_EVIDENCE_FIELDS,
    });
    const { assignmentId } = await call<{ assignmentId: string }>(admin, "POST", `/api/admin/jobs/${jobId}/assign`, { agentId: mercy.id });
    ids.push(assignmentId);
  }
  await call(agent, "POST", `/api/agent/assignments/${ids[1]}/accept`);
  return { waiting: ids[0], accepted: ids[1] };
}

async function measure(page: Page): Promise<{ controls: Control[]; scrollWidth: number; clientWidth: number }> {
  // tsx compiles named functions with an __name() helper that the browser lacks.
  await page.evaluate("window.__name = (f) => f");
  return page.evaluate(({ selector, minimum }) => {
    const nameOf = (el: HTMLElement): string => {
      const aria = el.getAttribute("aria-label");
      if (aria) return aria;
      const input = el as HTMLInputElement;
      if (input.labels && input.labels.length > 0) return input.labels[0].innerText.trim();
      if (input.type === "radio" || input.type === "checkbox") return el.parentElement?.innerText.trim() ?? input.value;
      const text = el.innerText?.trim();
      if (text) return text.replace(/\s+/g, " ").slice(0, 80);
      return input.value || input.name || el.id || el.tagName.toLowerCase();
    };
    const controls = Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      })
      .map((el) => {
        const box = el.getBoundingClientRect();
        const width = Math.round(box.width * 10) / 10;
        const height = Math.round(box.height * 10) / 10;
        return { tag: el.tagName.toLowerCase(), type: el.getAttribute("type"), name: nameOf(el), width, height, meets: width >= minimum && height >= minimum };
      });
    return { controls, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  }, { selector: INTERACTIVE, minimum: MINIMUM });
}

function summarise(name: string, urlPath: string, result: Awaited<ReturnType<typeof measure>>) {
  const failing = result.controls.filter((c) => !c.meets);
  return {
    page: name,
    path: urlPath,
    noHorizontalScroll: result.scrollWidth <= result.clientWidth,
    scrollWidth: result.scrollWidth,
    clientWidth: result.clientWidth,
    controls: result.controls.length,
    meeting48x48: result.controls.length - failing.length,
    belowMinimum: failing,
    smallestWidth: Math.min(...result.controls.map((c) => c.width)),
    smallestHeight: Math.min(...result.controls.map((c) => c.height)),
    all: result.controls,
  };
}

async function main(): Promise<void> {
  const outFile = process.argv[2] ?? "../docs/chapter5/evidence/nfr12-touch-targets.json";
  const { waiting, accepted } = await assignTwo();
  const session = await signIn(AGENT_EMAIL);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const eq = session.cookie.indexOf("=");
  await context.addCookies([{ name: session.cookie.slice(0, eq), value: decodeURIComponent(session.cookie.slice(eq + 1)), domain: new URL(APP).hostname, path: "/" }]);
  const page = await context.newPage();
  try {
    await page.goto(`${APP}/agent`, { waitUntil: "networkidle" });
    const jobList = summarise("Agent job list", "/agent", await measure(page));

    await page.goto(`${APP}/agent/submit/${accepted}`, { waitUntil: "networkidle" });
    await page.waitForSelector("form");
    await page.locator("details > summary").first().click();
    await page.waitForTimeout(200);
    const form = summarise("Agent submission form (device details opened)", `/agent/submit/${accepted}`, await measure(page));

    const pages = [jobList, form];
    const out = {
      requirement: "NFR-12: operable at 360 px width; every interactive control at least 48 x 48 px",
      measuredAt: new Date().toISOString(),
      app: APP,
      viewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, isMobile: true },
      minimumPx: MINIMUM,
      selector: INTERACTIVE,
      setup: { waitingAssignmentId: waiting, acceptedAssignmentId: accepted, note: "two jobs posted by client2 and assigned to Mercy through the API; the second accepted through the API" },
      allControlsMeet48: pages.every((p) => p.belowMinimum.length === 0),
      noHorizontalScrollOnEitherPage: pages.every((p) => p.noHorizontalScroll),
      contrastNote: "Measures size and width only. Colour contrast (IR-10, WCAG 2.1 AA) is not audited here.",
      pages,
    };
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
    for (const p of pages) {
      console.log(`${p.page}: ${p.meeting48x48}/${p.controls} controls at least ${MINIMUM}x${MINIMUM}; smallest ${p.smallestWidth} x ${p.smallestHeight}; horizontal scroll: ${p.noHorizontalScroll ? "none" : `${p.scrollWidth} > ${p.clientWidth}`}`);
      for (const c of p.belowMinimum) console.log(`  BELOW  ${c.tag}${c.type ? `[${c.type}]` : ""} "${c.name}" ${c.width} x ${c.height}`);
    }
    console.log(`Wrote ${outFile}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
