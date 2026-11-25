/**
 * IR-10: audits colour contrast and target size on the app's screens, for
 * each role, at 360 px and desktop width, with axe-core through Playwright.
 *
 * axe rules run: color-contrast (WCAG 2.1 SC 1.4.3) and target-size (24 x 24
 * px with its spacing exception: SC 2.5.8, which is WCAG 2.2 level AA; WCAG
 * 2.1 has no target-size criterion below level AAA). axe tests neither
 * placeholder text nor the boundaries of controls, so this script measures
 * both from the computed styles (SC 1.4.3 and 1.4.11). Where axe cannot
 * judge a text's contrast (mostly content scrolled out of view at 360 px), the
 * ratio is worked out here from the computed colours, and reported separately
 * from axe's own findings. It also counts controls under 44 x 44 px
 * (SC 2.5.5, level AAA) for information only.
 *
 * Read only: it signs in as the seeded accounts and opens pages. Every
 * request from the browser other than GET, HEAD and OPTIONS is blocked, so a
 * form it opens cannot be sent.
 *
 * Usage: APP_URL=<origin> npx tsx scripts/audit-accessibility.ts <out.json> [label]
 * AUDIT_ONLY="Sign up,Post a job" audits only the screens named.
 *
 * The sign-up state with a place chosen answers the place search itself, with
 * a stand-in result served by the browser: nothing is sent to OpenStreetMap.
 */
import fs from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { NON_TEXT_MINIMUM, TEXT_MINIMUM, contrastRatio, effectiveBackground, parseColor } from "./a11y/contrast";
import { resolveUnjudged } from "./a11y/resolve";
import { APP, signIn } from "./demo-client";
import { MAP_HOSTS } from "../src/lib/map/config";

const RULES = ["color-contrast", "target-size"];
const AAA_TARGET_PX = 44;
const VIEWPORTS = [
  { name: "360", viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1366, height: 900 }, isMobile: false, hasTouch: false },
];
const ADMIN = "reviewer@ledgerfield.test";
const CLIENT = "client2@ledgerfield.test";
const AGENTS = ["mercy@ledgerfield.test", "grace@ledgerfield.test", "samuel@ledgerfield.test"];
/** Buttons that only reveal a form. Nothing is sent: writes are blocked in any case. */
const OPENERS = /^(Contest the refusal|Withdraw activation|Close this job|Reject)$/;

type Role = "anonymous" | "agent" | "client" | "admin";
type Step = (page: Page) => Promise<void>;
type Screen = {
  name: string;
  /** One of the screens the audit was asked to cover; the rest are the app's other screens. */
  requested: boolean;
  role: Role;
  /** Null when the data holds nothing to show this screen with. */
  path: string | null;
  email?: string;
  states: Array<{ name: string; step: Step }>;
};

/**
 * Sign-up with a place chosen: the search is answered here with a made-up
 * result (a page route outranks the context route that blocks the host), the
 * result is chosen, and the values under Advanced are shown.
 */
async function chooseStandInPlace(page: Page): Promise<void> {
  const answer = [{ lat: "-1.25", lon: "36.88", display_name: "Stand-in place for the audit, Nairobi, Kenya" }];
  await page.route(
    (url) => MAP_HOSTS.includes(url.hostname),
    (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(answer) }),
  );
  await page.fill("#homeSearch", "stand-in");
  await page.press("#homeSearch", "Enter");
  await page.locator(".map-result").first().click();
  await page.evaluate('document.querySelectorAll("details").forEach((d) => { d.open = true; })');
}

/** Advanced opened, "Enter coordinates yourself" ticked, and a point outside Kenya typed, so the warning shows. */
async function typeOutsideKenya(page: Page, fields: [string, string]): Promise<void> {
  await page.evaluate('document.querySelectorAll("details").forEach((d) => { d.open = true; })');
  await page.getByLabel("Enter coordinates yourself").check();
  await page.fill(fields[0], "51.5");
  await page.fill(fields[1], "-0.12");
  await page.getByText("This point is outside Kenya").waitFor();
}

async function openEverything(page: Page): Promise<void> {
  await page.evaluate('document.querySelectorAll("details").forEach((d) => { d.open = true; })');
  const openers = page.getByRole("button", { name: OPENERS });
  for (let i = (await openers.count()) - 1; i >= 0; i -= 1) {
    const button = openers.nth(i);
    if (await button.isEnabled()) await button.click();
  }
}

const LOADED = { name: "as loaded", step: async () => {} };
const OPENED = { name: "sections and forms opened", step: openEverything };

function screen(name: string, role: Role, route: string | null, options: Partial<Screen> = {}): Screen {
  return { name, requested: true, role, path: route, states: [LOADED, OPENED], ...options };
}

function other(name: string, role: Role, route: string | null, email?: string): Screen {
  return screen(name, role, route, { requested: false, email });
}

const EMAIL_FOR: Record<Exclude<Role, "anonymous">, string> = { agent: AGENTS[0], client: CLIENT, admin: ADMIN };

const sessions = new Map<string, string>();

async function contextFor(browser: Browser, view: (typeof VIEWPORTS)[number], email: string | null, blocked: string[]): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: view.viewport, isMobile: view.isMobile, hasTouch: view.hasTouch });
  await context.route("**/*", (route) => {
    const method = route.request().method();
    // OpenStreetMap's tile and search policies forbid automated clients: the map is audited without tiles.
    if (MAP_HOSTS.includes(new URL(route.request().url()).hostname)) return route.abort();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return route.continue();
    blocked.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });
  if (email) {
    if (!sessions.has(email)) sessions.set(email, (await signIn(email)).cookie);
    const cookie = sessions.get(email)!;
    const at = cookie.indexOf("=");
    const url = new URL(APP);
    await context.addCookies([{ name: cookie.slice(0, at), value: decodeURIComponent(cookie.slice(at + 1)), domain: url.hostname, path: "/", httpOnly: true, secure: url.protocol === "https:", sameSite: "Lax" }]);
  }
  return context;
}

async function visit(page: Page, route: string): Promise<void> {
  const response = await page.goto(`${APP}${route}`, { waitUntil: "networkidle", timeout: 60_000 });
  const landed = new URL(page.url()).pathname;
  if (landed !== route.split(/[?#]/)[0]) throw new Error(`${route} redirected to ${landed}`);
  if (response && response.status() >= 400 && !route.includes("no-such-page")) throw new Error(`${route} answered ${response.status()}`);
  await page.evaluate("document.fonts.ready");
}

/** The links on a page whose address matches, in page order. */
async function matchingLinks(page: Page, route: string, pattern: RegExp): Promise<string[]> {
  await visit(page, route);
  const hrefs = (await page.evaluate('Array.from(document.querySelectorAll("a[href]"), (a) => a.getAttribute("href"))')) as string[];
  return [...new Set(hrefs.filter((href) => pattern.test(href)))];
}

async function discover(browser: Browser, blocked: string[]): Promise<Screen[]> {
  const links = async (email: string, route: string, pattern: RegExp) => {
    const context = await contextFor(browser, VIEWPORTS[1], email, blocked);
    try {
      return await matchingLinks(await context.newPage(), route, pattern);
    } finally {
      await context.close();
    }
  };
  const find = async (email: string, route: string, pattern: RegExp) => (await links(email, route, pattern))[0] ?? null;
  let submit: { route: string; email: string } | null = null;
  for (const email of AGENTS) {
    const route = await find(email, "/agent", /^\/agent\/submit\/[^/]+$/);
    if (route) {
      submit = { route, email };
      break;
    }
  }
  const activation = await find(AGENTS[0], "/agent/activations", /^\/agent\/activations\/[^/]+$/);
  const clientJobs = await links(CLIENT, "/client", /^\/client\/jobs\/(?!new)[^/]+$/);
  // The first job with each kind of link: a new job has no activations, and a decided one takes no activity.
  let clientJob: string | null = null;
  let activity: string | null = null;
  let clientAudit: string | null = null;
  for (const job of clientJobs) {
    const found = await links(CLIENT, job, /^\/client\/activations\/[^/]+\/(audit|activity)$/);
    activity ??= found.find((href) => href.endsWith("/activity")) ?? null;
    const audit = found.find((href) => href.endsWith("/audit")) ?? null;
    if (audit && !clientAudit) [clientAudit, clientJob] = [audit, job];
    if (activity && clientAudit) break;
  }
  clientJob ??= clientJobs[0] ?? null;
  const review = await find(ADMIN, "/admin/review", /^\/admin\/review\/[^/?]+$/);
  const adminJob = await find(ADMIN, "/admin/jobs", /^\/admin\/jobs\/[^/]+$/);
  const agentPage = await find(ADMIN, "/admin/agents", /^\/admin\/agents\/[^/]+$/);

  const signupStates = [
    { name: "agent form, as loaded", step: async () => {} },
    { name: "place searched, chosen, advanced open", step: chooseStandInPlace },
    { name: "coordinates typed, outside Kenya", step: async (page: Page) => typeOutsideKenya(page, ["#homeLat", "#homeLon"]) },
    { name: "client form", step: async (page: Page) => page.getByLabel("A client business").check() },
    { name: "errors shown", step: async (page: Page) => page.getByRole("button", { name: "Create account" }).click() },
  ];
  const openEscrow = async (page: Page) => {
    await page.evaluate('const d = document.getElementById("fund-escrow"); if (d) { d.open = true; d.scrollIntoView(); }');
  };
  return [
    screen("Sign in", "anonymous", "/login", { states: [LOADED] }),
    screen("Sign up", "anonymous", "/signup", { states: signupStates }),
    screen("Agent job list", "agent", "/agent"),
    screen("Activation form", "agent", submit?.route ?? null, {
      email: submit?.email,
      // The audit browser has no location, so pressing Submit shows the "turn on location" message; nothing can be sent.
      states: [LOADED, OPENED, { name: "submit pressed with no location", step: async (page) => page.getByRole("button", { name: "Submit activation" }).click() }],
    }),
    screen("Client dashboard", "client", "/client", { states: [LOADED] }),
    screen("Post a job", "client", "/client/jobs/new", {
      states: [
        LOADED,
        { name: "an evidence field added", step: async (page) => page.getByRole("button", { name: "+ Choice from a list" }).click() },
        { name: "publish pressed with nothing entered", step: async (page) => page.getByRole("button", { name: "Publish the job" }).click() },
        { name: "coordinates typed, outside Kenya", step: async (page) => typeOutsideKenya(page, ["#areaLat", "#areaLon"]) },
      ],
    }),
    screen("Escrow", "client", "/client", { states: [{ name: "funding section open", step: openEscrow }, OPENED] }),
    screen("Admin dashboard", "admin", "/admin"),
    screen("Review queue", "admin", "/admin/review"),
    screen("Review screen", "admin", review),
    screen("Payouts", "admin", "/admin/payouts"),
    other("Agent activations", "agent", "/agent/activations"),
    other("Agent activation detail", "agent", activation),
    other("Client job", "client", clientJob),
    other("Client evidence fields", "client", clientJob ? `${clientJob}/evidence` : null),
    other("Client activity report", "client", activity),
    other("Client audit record", "client", clientAudit),
    other("Queue: awaiting evidence", "admin", "/admin/review?tab=evidence"),
    other("Review evidence gallery", "admin", review ? `${review}/evidence` : null),
    other("Admin jobs", "admin", "/admin/jobs"),
    other("Admin job", "admin", adminJob),
    other("Admin agents", "admin", "/admin/agents"),
    other("Admin agent", "admin", agentPage),
    other("Admin clients", "admin", "/admin/clients"),
    other("Admin audit log", "admin", "/admin/audit"),
    other("Not found", "anonymous", "/no-such-page"),
  ];
}

type Measured = {
  placeholders: Array<{ target: string; color: string; backgrounds: string[] }>;
  boundaries: Array<{ target: string; border: string; borderWidth: number; own: string[]; outside: string[] }>;
  targets: Array<{ target: string; width: number; height: number }>;
};

/** Raw colours and sizes from the rendered page; the ratios are worked out here, not in the browser. */
async function measure(page: Page): Promise<Measured> {
  // tsx compiles named functions with an __name() helper that the browser lacks.
  await page.evaluate("window.__name = (f) => f");
  return page.evaluate(() => {
    const path = (el: Element): string => {
      if (el.id) return `#${el.id}`;
      const parent = el.parentElement;
      const name = `${el.tagName.toLowerCase()}${el.classList.length ? `.${[...el.classList].join(".")}` : ""}`;
      if (!parent || parent === document.body) return name;
      const index = [...parent.children].indexOf(el) + 1;
      return `${path(parent)} > ${name}:nth-child(${index})`;
    };
    const backgrounds = (start: Element | null): string[] => {
      const stack: string[] = [];
      for (let el = start; el; el = el.parentElement) {
        const color = getComputedStyle(el).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)") stack.push(color);
        if (color.startsWith("rgb(")) break;
      }
      return stack;
    };
    const shown = (el: Element) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return box.width > 1 && box.height > 1 && style.visibility !== "hidden" && el.checkVisibility();
    };
    const all = (selector: string) => [...document.querySelectorAll<HTMLInputElement>(selector)].filter(shown);
    const fields = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="submit"]), select, textarea';
    return {
      placeholders: all("input[placeholder], textarea[placeholder]")
        .filter((el) => el.value === "" && !el.disabled)
        .map((el) => ({ target: path(el), color: getComputedStyle(el, "::placeholder").color, backgrounds: backgrounds(el) })),
      boundaries: all(fields)
        .filter((el) => !el.disabled)
        .map((el) => {
          const style = getComputedStyle(el);
          return { target: path(el), border: style.borderTopColor, borderWidth: parseFloat(style.borderTopWidth), own: backgrounds(el), outside: backgrounds(el.parentElement) };
        }),
      targets: all('a[href], button, input:not([type="hidden"]), select, textarea, summary').map((el) => {
        const box = el.getBoundingClientRect();
        return { target: path(el), width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10 };
      }),
    };
  });
}

const rounded = (ratio: number) => Math.floor(ratio * 100) / 100;

function judge(measured: Measured) {
  const placeholder = measured.placeholders
    .map((p) => ({ target: p.target, color: p.color, ratio: rounded(contrastRatio(parseColor(p.color), effectiveBackground(p.backgrounds))), required: TEXT_MINIMUM }))
    .filter((p) => p.ratio < p.required);
  const boundary = measured.boundaries
    .map((b) => {
      const outside = effectiveBackground(b.outside);
      const border = b.borderWidth > 0 ? contrastRatio(parseColor(b.border), outside) : 1;
      const fill = contrastRatio(effectiveBackground([...b.own, ...b.outside]), outside);
      return { target: b.target, border: b.border, ratio: rounded(Math.max(border, fill)), required: NON_TEXT_MINIMUM };
    })
    .filter((b) => b.ratio < b.required);
  const under44 = measured.targets.filter((t) => t.width < AAA_TARGET_PX || t.height < AAA_TARGET_PX);
  return { placeholder, boundary, controls: measured.targets.length, under44 };
}

type AxeResult = Awaited<ReturnType<AxeBuilder["analyze"]>>;

function compact(results: AxeResult["violations"]) {
  return results.map((rule) => ({
    rule: rule.id,
    impact: rule.impact,
    nodes: rule.nodes.map((node) => ({
      target: node.target.join(" "),
      checks: [...node.any, ...node.all, ...node.none].map((check) => ({ message: check.message, data: check.data as unknown })),
    })),
  }));
}

async function auditState(page: Page) {
  const axe = await new AxeBuilder({ page }).withRules(RULES).analyze();
  const unjudged = axe.incomplete.find((rule) => rule.id === "color-contrast")?.nodes ?? [];
  return {
    axeVersion: axe.testEngine.version,
    violations: compact(axe.violations),
    incomplete: compact(axe.incomplete),
    resolved: await resolveUnjudged(page, unjudged.map((node) => node.target.join(" "))),
    ...judge(await measure(page)),
  };
}

type Entry = { screen: string; requested: boolean; role: Role; path: string | null; width: string; state: string; error?: string } & Partial<Awaited<ReturnType<typeof auditState>>>;

async function auditScreen(browser: Browser, target: Screen, blocked: string[]): Promise<Entry[]> {
  const base = { screen: target.name, requested: target.requested, role: target.role, path: target.path };
  if (!target.path) return [{ ...base, width: "-", state: "-", error: "not audited: the data holds no record to open this screen with" }];
  const email = target.role === "anonymous" ? null : target.email ?? EMAIL_FOR[target.role];
  const entries: Entry[] = [];
  for (const view of VIEWPORTS) {
    for (const state of target.states) {
      const context = await contextFor(browser, view, email, blocked);
      const page = await context.newPage();
      try {
        await visit(page, target.path);
        await state.step(page);
        await page.waitForTimeout(400);
        entries.push({ ...base, width: view.name, state: state.name, ...(await auditState(page)) });
      } catch (error) {
        entries.push({ ...base, width: view.name, state: state.name, error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
      } finally {
        await context.close();
      }
    }
  }
  return entries;
}

function nodeCount(results: Array<{ rule: string; nodes: unknown[] }> | undefined, rule: string): number {
  return results?.find((r) => r.rule === rule)?.nodes.length ?? 0;
}

/** Node counts summed over every screen, state and width; one element seen twice counts twice. */
function totalsOf(entries: Entry[]) {
  const sum = (pick: (entry: Entry) => number) => entries.reduce((total, entry) => total + pick(entry), 0);
  return {
    statesAudited: entries.filter((e) => !e.error).length,
    statesNotAudited: entries.filter((e) => e.error).length,
    textContrast: sum((e) => nodeCount(e.violations, "color-contrast")),
    textContrastFoundBySelfCheck: sum((e) => e.resolved?.filter((r) => r.verdict === "fail").length ?? 0),
    textContrastStillUndetermined: sum((e) => e.resolved?.filter((r) => r.verdict === "undetermined").length ?? 0),
    placeholderContrast: sum((e) => e.placeholder?.length ?? 0),
    controlBoundaryContrast: sum((e) => e.boundary?.length ?? 0),
    targetSize24: sum((e) => nodeCount(e.violations, "target-size")),
    textContrastNotJudgedByAxe: sum((e) => nodeCount(e.incomplete, "color-contrast")),
    targetSizeIncomplete: sum((e) => nodeCount(e.incomplete, "target-size")),
    controlsMeasured: sum((e) => e.controls ?? 0),
    controlsUnder44ForInformation: sum((e) => e.under44?.length ?? 0),
  };
}

async function main(): Promise<void> {
  const [out, label = "audit"] = process.argv.slice(2);
  if (!out) throw new Error("Usage: audit-accessibility.ts <out.json> [label]");
  const startedAt = new Date().toISOString();
  const browser = await chromium.launch();
  const blocked: string[] = [];
  const entries: Entry[] = [];
  try {
    const only = process.env.AUDIT_ONLY?.split(",").map((name) => name.trim());
    const targets = (await discover(browser, blocked)).filter((target) => !only || only.includes(target.name));
    if (only && targets.length !== only.length) throw new Error(`AUDIT_ONLY names a screen that does not exist: ${process.env.AUDIT_ONLY}`);
    for (const target of targets) {
      const found = await auditScreen(browser, target, blocked);
      entries.push(...found);
      const t = totalsOf(found);
      console.log(`${target.name}: text ${t.textContrast}+${t.textContrastFoundBySelfCheck}, undetermined ${t.textContrastStillUndetermined}, placeholder ${t.placeholderContrast}, boundary ${t.controlBoundaryContrast}, target ${t.targetSize24}+${t.targetSizeIncomplete}${t.statesNotAudited ? `, NOT AUDITED ${t.statesNotAudited}` : ""}`);
    }
    const report = {
      requirement: "IR-10: WCAG 2.1 level AA for contrast ratio and target size",
      label,
      screensAudited: only ?? "all",
      app: APP,
      startedAt,
      finishedAt: new Date().toISOString(),
      browser: `chromium ${browser.version()}`,
      axeCore: entries.find((e) => e.axeVersion)?.axeVersion ?? null,
      axeRules: RULES,
      widths: VIEWPORTS.map((v) => ({ name: v.name, ...v.viewport })),
      blockedRequests: blocked,
      totals: { requestedScreens: totalsOf(entries.filter((e) => e.requested)), allScreens: totalsOf(entries) },
      entries,
    };
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
    console.log(JSON.stringify(report.totals, null, 1));
    for (const e of entries.filter((entry) => entry.error)) console.log(`NOT AUDITED ${e.screen} [${e.width}, ${e.state}]: ${e.error}`);
    console.log(`blocked requests: ${blocked.length}; written ${out}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
