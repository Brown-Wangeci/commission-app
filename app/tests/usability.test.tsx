import fs from "node:fs";
import path from "node:path";
import type { ActivationState } from "@prisma/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Disclosure } from "@/components/Disclosure";
import { EmptyState } from "@/components/EmptyState";
import { Preview, DEFAULT_RADIUS_M, DEFAULT_RATE_PERCENT, DEFAULT_SLOTS } from "@/components/client/PostJobForm";
import { ReasonList } from "@/components/review/ReasonList";
import { ALL_STATES } from "@/lib/activations/states";
import { canAssign, openSlots, whyNotAssignable } from "@/lib/jobs/assignable";
import { DEFAULT_DEADLINE_DAYS, defaultDeadline } from "@/lib/jobs/defaults";
import { everyStateIsGrouped, groupCounts, ordered, STATE_GROUPS, type AttentionItem } from "@/lib/review/dashboard";
import { noScoreReason, noScoreSentence } from "@/lib/review/copy";
import { NO_ACTIVITY_MESSAGE } from "@/lib/scoring/messages";
import type { ReasonView } from "@/lib/review/reasons";

/** The usability pass, item by item, without a database. */

const read = (file: string) => fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/\r\n/g, "\n");

describe("item 2: the dashboard groups the state counts", () => {
  it("puts every state in exactly one group", () => {
    expect(everyStateIsGrouped()).toBe(true);
    const all = STATE_GROUPS.flatMap((group) => group.states);
    expect(new Set(all).size).toBe(ALL_STATES.length);
  });

  it("names the three groups and totals each from the counts", () => {
    const counts = new Map<ActivationState, number>([["held", 4], ["in_review", 2], ["disputed", 1], ["approved", 9], ["refused", 3]]);
    const groups = groupCounts(counts);
    expect(groups.map((group) => [group.label, group.total])).toEqual([["In progress", 4], ["Needs a person", 3], ["Done", 12]]);
  });

  it("orders attention items so those with something to do come first", () => {
    const item = (id: AttentionItem["id"], count: number): AttentionItem => ({ id, count, label: id, detail: "", href: "/", action: "Open" });
    expect(ordered([item("decisions", 0), item("unscored", 2), item("payouts", 0), item("jobs", 1)]).map((i) => i.id)).toEqual(["unscored", "jobs", "decisions", "payouts"]);
  });

  it("moves recent scores, recent decisions and the hold window into tabs", () => {
    const page = read("src/app/admin/page.tsx");
    expect(page).toContain("Needs your attention");
    for (const tab of ["Recent model scores", "Recent reviewer decisions", "Hold window"]) expect(page).toContain(tab);
    expect(page).toMatch(/view === "scores" && <Scores/);
    expect(page).toMatch(/view === "hold" && <HoldWindowPanel/);
    expect(page).not.toMatch(/<HoldWindowPanel \/>\s*<\/main>/);
  });
});

describe("item 3: the review screen opens on evidence, score and decision", () => {
  const page = read("src/app/admin/review/[id]/page.tsx");

  it("collapses submitted details, the map, the history and the audit record", () => {
    for (const id of ["details", "location", "history"]) expect(page).toContain(`<Disclosure id="${id}"`);
    expect(page).toMatch(/<AuditTrailPanel collapsible/);
  });

  it("shows evidence, then the score, then the decision without a click", () => {
    expect(page.indexOf("<ConcernCallout")).toBeLessThan(page.indexOf("<EvidenceStrip"));
    // The decision is the first thing in the right-hand column, so it is on the first screen; the score and its top reasons follow at once.
    expect(page.indexOf("<PayoutPanel")).toBeLessThan(page.indexOf("<ModelAssessment"));
    expect(page.indexOf("<ModelAssessment")).toBeLessThan(page.indexOf("<AgentCard"));
  });

  it("keeps what was asked of the agent in view while evidence is awaited, not behind History", () => {
    expect(page).toContain("Waiting for the agent");
    expect(page.indexOf("Waiting for the agent")).toBeLessThan(page.indexOf("<ConcernCallout"));
    expect(page).toMatch(/request\.status === "open"/);
  });

  it("has one primary button, with ask for evidence and reject quiet", () => {
    const panel = read("src/components/review/PayoutPanel.tsx");
    const decide = panel.slice(panel.indexOf('className="decide-buttons"'), panel.indexOf("{open && ("));
    expect(decide.match(/btn primary/g)).toHaveLength(1);
    expect(decide.match(/btn quiet/g)).toHaveLength(2);
    expect(decide).not.toMatch(/btn danger"/);
  });

  it("shows the top three reasons and the rest on click", () => {
    const reason = (rank: number): ReasonView => ({ rank, feature: `f${rank}`, description: `factor ${rank}`, contribution: 1 - rank / 10, raisesRisk: true, isAgentLevel: false });
    const reasons = [1, 2, 3, 4, 5].map(reason);
    const html = renderToStaticMarkup(<ReasonList reasons={reasons} top={3} />);
    expect(html.match(/<li class="factor/g)).toHaveLength(5);
    expect(html).toContain("2 more factors");
    const before = html.slice(0, html.indexOf("<details"));
    expect(before.match(/<li class="factor/g)).toHaveLength(3);
    expect(renderToStaticMarkup(<ReasonList reasons={reasons.slice(0, 3)} top={3} />)).not.toContain("<details");
  });

  it("opens a collapsed section from a link to it, by a plain anchor", () => {
    expect(read("src/components/Disclosure.tsx")).toContain('addEventListener("hashchange"');
    expect(read("src/components/review/ConcernCallout.tsx")).toMatch(/href\.startsWith\("#"\) \? <a /);
    expect(read("src/components/review/SubmittedDetails.tsx")).toContain('<a href="#location">map</a>');
  });

  it("renders a closed section with its title and a hint, open only when asked", () => {
    const closed = renderToStaticMarkup(<Disclosure id="x" title="History" hint="3 events"><p>body</p></Disclosure>);
    expect(closed).toContain('id="x"');
    expect(closed).toContain("<h2>History</h2>");
    expect(closed).toContain("3 events");
    expect(closed).not.toMatch(/<details[^>]* open/);
    expect(renderToStaticMarkup(<Disclosure id="x" title="History" defaultOpen><p>body</p></Disclosure>)).toMatch(/<details[^>]* open/);
  });
});

describe("item 4: assigning jobs", () => {
  const job = (overrides = {}) => ({ status: "open" as const, slots: 3, deadlineAt: null, ...overrides });

  it("offers Assign only to an open job with a free slot and a deadline still ahead", () => {
    const now = new Date("2026-11-16T12:00:00Z");
    expect(canAssign(job(), 2, now)).toBe(true);
    expect(canAssign(job(), 3, now)).toBe(false);
    expect(canAssign(job({ status: "closed" }), 0, now)).toBe(false);
    expect(canAssign(job({ deadlineAt: new Date("2026-11-15T00:00:00Z") }), 0, now)).toBe(false);
    expect(canAssign(job({ deadlineAt: new Date("2026-11-17T00:00:00Z") }), 0, now)).toBe(true);
    expect(openSlots(job(), 5)).toBe(0);
  });

  it("says why a job cannot be assigned", () => {
    const now = new Date("2026-11-16T12:00:00Z");
    expect(whyNotAssignable(job(), 1, now)).toBeNull();
    expect(whyNotAssignable(job({ status: "closed" }), 1, now)).toBe("Closed");
    expect(whyNotAssignable(job(), 3, now)).toBe("Every slot is assigned");
    expect(whyNotAssignable(job({ deadlineAt: new Date("2026-11-01T00:00:00Z") }), 1, now)).toBe("Deadline passed");
  });

  it("has a Jobs list in the reviewer's navigation, with an Assign action on each row", () => {
    expect(read("src/components/TopNav.tsx")).toContain('{ href: "/admin/jobs", label: "Jobs" }');
    const list = read("src/app/admin/jobs/page.tsx");
    expect(list).toContain("<AssignRowAction");
    expect(read("src/components/AssignRowAction.tsx")).toContain(">Assign</button>");
  });

  it("tells a client, after posting, that a reviewer assigns agents next", () => {
    expect(read("src/components/client/PostJobForm.tsx")).toContain("?posted=1");
    const page = read("src/app/client/jobs/[id]/page.tsx");
    expect(page).toContain("A reviewer assigns agents next");
  });
});

describe("item 5: the post-a-job form", () => {
  it("has the four groups in order, with the commission summary beside them", () => {
    const form = read("src/components/client/PostJobForm.tsx");
    const legends = [...form.matchAll(/<legend>([^<]+)<\/legend>/g)].map((m) => m[1]);
    expect(legends).toEqual(["1. The job", "2. Evidence the agent must submit", "3. Job area", "4. Commission"]);
    expect(form).toContain('className="post-summary card card-pad stack"');
    expect(form.indexOf("</fieldset>\n      </div>\n      <aside")).toBeGreaterThan(-1);
  });

  it("keeps the summary in view while the form scrolls", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/\.post-summary \{ position: sticky; top:/);
    expect(css).toMatch(/@media \(max-width: 1000px\) \{\s*\.post-layout[^}]*\}\s*\.post-summary \{ position: sticky; top: auto; bottom: 0/);
  });

  it("starts with sensible defaults, and a deadline 30 days ahead in Kenya's calendar", () => {
    expect([DEFAULT_SLOTS, DEFAULT_RATE_PERCENT, DEFAULT_RADIUS_M]).toEqual(["10", "10", "700"]);
    expect(DEFAULT_DEADLINE_DAYS).toBe(30);
    expect(defaultDeadline(new Date("2026-11-16T09:00:00Z"))).toBe("2026-12-16");
    expect(defaultDeadline(new Date("2026-11-16T22:30:00Z"))).toBe("2026-12-17"); // already the 17th in Nairobi
  });

  it("shows the commission and the amount to lock, with their working", () => {
    const html = renderToStaticMarkup(<Preview terms={{ value: "3000", rate: "10", flat: "", slots: "10" }} availableCents={5_000_000} />);
    expect(html).toContain("Commission per approved submission");
    expect(html).toContain("Locked from your escrow when you publish");
    expect(html).toContain("KSh 300.00");
    expect(html).toContain("KSh 3,000.00");
    expect(html).toContain("derivation");
    const blank = renderToStaticMarkup(<Preview terms={{ value: "", rate: "10", flat: "", slots: "10" }} availableCents={5_000_000} />);
    expect(blank).toContain("Available now: KSh 50,000.00");
    const short = renderToStaticMarkup(<Preview terms={{ value: "3000", rate: "10", flat: "", slots: "10" }} availableCents={100} />);
    expect(short).toContain("Publishing will be refused");
  });
});

describe("item 6: wording when there is no first-week activity", () => {
  const missing = { kind: "missing_input", message: NO_ACTIVITY_MESSAGE };

  it("names the missing first week for a hold-close score", () => {
    expect(noScoreReason("t7", missing)).toBe("the hold-close model needs the customer's first week of activity, and none has been reported");
    expect(noScoreSentence("t7", missing)).not.toMatch(/could not be reached/);
  });

  it("does not claim the first week is missing for any other missing input", () => {
    const other = { kind: "missing_input", message: "the assignment was never accepted" };
    expect(noScoreReason("t7", other)).toBe("information the model needs was missing at hold-close");
  });

  it("keeps the earlier wording when the service was the problem, or nothing is recorded", () => {
    expect(noScoreReason("t0", { kind: "timeout", message: "x" })).toBe("the model could not be reached at submission");
    expect(noScoreReason("t7", null)).toBe("the model could not be reached at hold-close");
  });

  it("uses the same message the scorer records, so the two cannot drift apart", () => {
    expect(read("src/lib/scoring/payload.ts")).toContain("new PayloadError(NO_ACTIVITY_MESSAGE)");
  });
});

describe("item 7: every list has an empty state", () => {
  it("says what the list is, what will appear and who acts next", () => {
    const html = renderToStaticMarkup(
      <EmptyState title="No jobs for you right now" next="A reviewer assigns jobs." action={{ href: "/agent", label: "Go" }}>Each job appears here.</EmptyState>,
    );
    expect(html).toContain("No jobs for you right now");
    expect(html).toContain("Each job appears here.");
    expect(html).toContain("A reviewer assigns jobs.");
    expect(html).toContain("Next");
    expect(html).toContain('href="/agent"');
  });

  it("is used by every list that can be empty", () => {
    const files = [
      "src/app/admin/page.tsx", "src/app/admin/review/page.tsx", "src/app/admin/jobs/page.tsx", "src/app/admin/agents/page.tsx",
      "src/app/admin/agents/[id]/page.tsx", "src/app/admin/clients/page.tsx", "src/app/admin/jobs/[id]/page.tsx", "src/app/admin/payouts/page.tsx",
      "src/app/admin/audit/page.tsx", "src/app/admin/review/[id]/evidence/page.tsx", "src/app/agent/page.tsx", "src/app/agent/activations/page.tsx",
      "src/app/agent/activations/[id]/page.tsx", "src/app/client/page.tsx", "src/app/client/jobs/[id]/page.tsx", "src/components/HoldWindowPanel.tsx",
      "src/components/client/FundingList.tsx", "src/components/audit/AuditTrailPanel.tsx",
    ];
    for (const file of files) expect(read(file), file).toContain("<EmptyState");
  });

  it("leaves no bare one-line empty message behind", () => {
    const pages = ["src/app", "src/components"].flatMap((dir) => walk(path.join(__dirname, "..", dir)));
    const offenders = pages.filter((file) => /className="(card )?empty">[A-Z]/.test(fs.readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("item 8: client and agent home pages", () => {
  it("puts a client's jobs ahead of their escrow, and funding inside a section that opens", () => {
    const page = read("src/app/client/page.tsx");
    expect(page.indexOf("Open jobs")).toBeLessThan(page.indexOf("Your escrow"));
    expect(page).toContain('<Disclosure id="fund-escrow"');
    expect(page).toContain("Closed jobs");
  });

  it("puts what an agent must do now first, and the steps of a job in a section that opens", () => {
    const page = read("src/app/agent/page.tsx");
    expect(page.indexOf("id=\"accept-heading\"")).toBeLessThan(page.indexOf("id=\"submit-heading\""));
    expect(page).toContain("How a job works");
    expect(page).toContain("<EmptyState");
  });

  it("keeps 48 px targets and the phone layout on the agent screens", () => {
    const css = read("src/app/globals.css");
    expect(css).toContain("--touch: 48px");
    expect(css).toMatch(/\.agent-app summary \{[^}]*min-height: var\(--touch\)/);
    expect(css).toMatch(/\.agent-app \.btn, \.agent-app \.btn\.small \{ min-width: var\(--touch\)/);
  });
});

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx$/.test(entry.name) ? [full] : [];
  });
}
