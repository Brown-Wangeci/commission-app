import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WhatHappened } from "@/components/audit/AuditTrailPanel";
import { EvidenceFieldsEditor, blankRow, rowsFromDefinitions } from "@/components/client/EvidenceFieldsEditor";
import { FundingList, RECENT_FUNDING, type FundingRow } from "@/components/client/FundingList";
import { PostJobForm, summaryLine } from "@/components/client/PostJobForm";
import type { AuditRecordEvent } from "@/lib/audit/history";
import type { FieldDefinition } from "@/lib/evidence/fields";

// The forms use the app router; rendering them here needs only a stand-in.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

/**
 * UI pass, PR 4: less on each screen. Presentation only; these tests hold
 * what each screen now shows first and what it moved out of the way.
 */
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
const css = read("src/app/globals.css");

describe("the post-a-job summary is one line on a phone", () => {
  const terms = { value: "100", rate: "10", flat: "", slots: "10" };

  it("says the commission and what publishing locks, or what is missing", () => {
    expect(summaryLine(terms, 1_000_000)).toEqual({ text: "KSh 10.00 per sign-up · locks KSh 100.00", short: false });
    expect(summaryLine({ ...terms, value: "" }, 1_000_000)).toEqual({ text: "Enter the value, rate and activations to see the commission.", short: false });
  });

  it("says how much more to fund when escrow does not cover it", () => {
    expect(summaryLine(terms, 4_000)).toEqual({ text: "Locks KSh 100.00: fund KSh 60.00 more first.", short: true });
  });

  it("keeps the full summary behind Details, closed at first, and the Publish button in the bar", () => {
    const html = renderToStaticMarkup(<PostJobForm availableCents={0} defaultDeadline="2026-12-25" accountReviewSetting={false} />);
    expect(html).toContain('class="post-summary card card-pad stack" aria-labelledby="summary-heading" data-expanded="false"');
    expect(html).toContain('aria-expanded="false" aria-controls="summary-detail"');
    expect(html).toContain('id="summary-detail" class="post-summary-detail"');
    expect(css).toMatch(/@media \(max-width: 1000px\) \{[^@]*\.post-summary\[data-expanded="false"\] \.post-summary-detail \{ display: none; \}/);
    expect(css).toContain(".post-summary-line, .post-summary-toggle { display: none; }");
  });
});

describe("the agent's screens put what to do first", () => {
  it("drops the button that repeated the My activations tab, and lists notifications after the jobs", () => {
    const page = read("src/app/agent/page.tsx");
    expect(page).not.toContain('href="/agent/activations" className="btn"');
    expect(page.indexOf("<NotificationsPanel")).toBeGreaterThan(page.indexOf('id="submit-heading"'));
    expect(page).not.toContain("amount.commission.derivation");
  });

  it("tells the activation's story in plain words, oldest first, from the audit events", () => {
    const event = (id: string, kind: string, toState: string | null): AuditRecordEvent => ({
      eventId: id, sequence: id, kind, at: "2026-11-25T14:52:20.000Z", fromState: null, toState, actorId: null, detail: null, hash: null, previousHash: null, anchor: { state: "awaiting_batch" },
    });
    const html = renderToStaticMarkup(<WhatHappened events={[event("1", "transition", "submitted"), event("2", "activation_submitted", null), event("3", "transition", "held")]} />);
    expect(html).toContain("What happened");
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html.indexOf("Submitted")).toBeLessThan(html.indexOf("Held"));
    expect(renderToStaticMarkup(<WhatHappened events={[event("2", "activation_submitted", null)]} />)).toBe("");
  });

  it("collapses the hash-by-hash record except in a refusal or dispute, and puts Withdraw last", () => {
    const page = read("src/app/agent/activations/[id]/page.tsx");
    expect(page).toContain("collapsible={!contested} plainSummary");
    expect(page).toContain('const contested = activation.state === "disputed" || activation.state === "refused";');
    expect(page.indexOf("<Withdraw detail={detail} />")).toBeGreaterThan(page.indexOf("Your evidence ("));
  });
});

describe("the client's screens show the money in fewer boxes", () => {
  const row = (n: number, status: FundingRow["status"] = "confirmed"): FundingRow => ({ id: `f${n}`, amountCents: 100_000 * n, status, receipt: null, failureReason: null, createdAt: new Date("2026-11-25T10:00:00Z") });

  it("shows the latest funding attempts and offers the rest", () => {
    const html = renderToStaticMarkup(<FundingList rows={[1, 2, 3, 4, 5].map((n) => row(n))} />);
    expect(html.match(/<tr>/g)).toHaveLength(RECENT_FUNDING + 1);
    expect(html).toContain("Show all 5 funding attempts");
  });

  it("always shows an attempt still waiting for M-Pesa", () => {
    const html = renderToStaticMarkup(<FundingList rows={[row(1), row(2), row(3), row(4), row(5, "pending")]} />);
    expect(html.match(/<tr>/g)).toHaveLength(RECENT_FUNDING + 2);
    expect(html).toContain("KSh 5,000.00");
  });

  it("draws the escrow as one card with Available first", () => {
    const page = read("src/app/client/page.tsx");
    expect(page).toContain('<div className="card stat escrow-card">');
    expect(page.indexOf('"stat-label">Available')).toBeLessThan(page.indexOf('"stat-label">Deposited'));
    expect(page).toContain('<Disclosure id="fund-escrow"');
  });

  it("lays a job's four amounts out two by two on a phone", () => {
    expect(read("src/app/client/jobs/[id]/page.tsx")).toContain('className="grid-4 stat-grid"');
    expect(css).toMatch(/@media \(max-width: 640px\) \{\s*\.grid-4\.stat-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  });

  it("folds each saved evidence field to one line, keeps a new one open, and saves from the action bar", () => {
    const saved: FieldDefinition[] = [{ key: "field_1", label: "ID document seen", type: "single_select", mandatory: true, help: null, format: { options: [{ value: "a", label: "A" }] } }];
    const html = renderToStaticMarkup(<EvidenceFieldsEditor rows={[...rowsFromDefinitions(saved), blankRow("text")]} onChange={() => {}} errors={{}} />);
    expect(html).toContain('<details class="field-row"><summary><span class="strong small">1. ID document seen</span>');
    expect(html).toContain('<details class="field-row" open=""><summary><span class="strong small">2. Untitled field</span>');
    expect(read("src/components/client/EditEvidenceFields.tsx")).toContain("<StickyActionBar>");
  });
});

describe("the reviewer can decide without scrolling to the end on a phone", () => {
  it("holds the existing decision buttons at the bottom of the screen at 640 px and below, and makes room for them", () => {
    expect(css).toMatch(/@media \(max-width: 640px\) \{\s*\.payout-panel \.decide-buttons \{\s*position: fixed; left: 0; right: 0; bottom: 0;/);
    expect(css).toContain("main:has(.payout-panel .decide-buttons) { padding-bottom: 140px; }");
  });
});
