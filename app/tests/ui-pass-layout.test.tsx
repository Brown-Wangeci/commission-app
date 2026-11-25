import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShowAllRows } from "@/components/ShowAllRows";
import { actionStyles } from "@/lib/ui/attention-actions";
import { SHOW_ALL_INITIAL } from "@/lib/ui/show-all";

/**
 * UI pass, PR 1: agent tables as cards on a phone, "Show all" on long
 * lists, one empty state per empty list, and one primary action on the
 * reviewer's dashboard. Presentation only.
 */
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");

function table(rows: number): ReactElement {
  return (
    <table>
      <tbody>{Array.from({ length: rows }, (_, i) => <tr key={i}><td>{i}</td></tr>)}</tbody>
    </table>
  );
}

describe("ShowAllRows caps a long list at the first rows until asked", () => {
  it("caps a list longer than the limit and offers the rest", () => {
    const html = renderToStaticMarkup(<ShowAllRows total={30} noun="payouts">{table(30)}</ShowAllRows>);
    expect(html).toContain('class="rows-capped"');
    expect(html).toContain("Show all 30 payouts");
    expect(html).toContain('aria-expanded="false"');
    expect(html.match(/<tr>/g)).toHaveLength(30);
  });

  it("leaves a list at or under the limit untouched", () => {
    const html = renderToStaticMarkup(<ShowAllRows total={SHOW_ALL_INITIAL} noun="payouts">{table(SHOW_ALL_INITIAL)}</ShowAllRows>);
    expect(html).not.toContain("rows-capped");
    expect(html).not.toContain("<button");
  });

  it("shows every row when told the rows past the cap still need someone", () => {
    const html = renderToStaticMarkup(<ShowAllRows total={40} noun="payouts" uncapped>{table(40)}</ShowAllRows>);
    expect(html).not.toContain("rows-capped");
    expect(html).not.toContain("<button");
  });

  it("hides rows from the one after the limit, in the stylesheet", () => {
    expect(read("src/app/globals.css")).toContain(`.rows-capped tbody tr:nth-child(n + ${SHOW_ALL_INITIAL + 1}) { display: none; }`);
  });

  it("is used on the payouts list and a job's assignments, keeping stuck payouts in view", () => {
    const payouts = read("src/app/admin/payouts/page.tsx");
    expect(payouts).toContain('<ShowAllRows total={ordered.length} noun="payouts" uncapped={stuck.length >= SHOW_ALL_INITIAL}>');
    expect(read("src/app/admin/jobs/[id]/page.tsx")).toContain('<ShowAllRows total={job.assignments.length} noun="assignments">');
  });
});

describe("agent tables become labelled cards on a phone", () => {
  for (const file of ["src/app/agent/activations/page.tsx", "src/components/audit/AuditTrailPanel.tsx"]) {
    it(`labels every cell of the table in ${file}`, () => {
      const source = read(file);
      expect(source).toContain('className="table table-cards"');
      const body = source.slice(source.indexOf("<tbody>"), source.indexOf("</tbody>"));
      const cells = body.match(/<td[\s>]/g) ?? [];
      expect(cells.length).toBeGreaterThan(0);
      expect(body.match(/<td data-label="[^"]+"/g)).toHaveLength(cells.length);
    });
  }

  it("applies the card layout on agent screens only", () => {
    const css = read("src/app/globals.css");
    const rules = css.match(/[^{}]*\.table-cards[^{}]*\{/g) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) for (const selector of rule.replace("{", "").split(",")) expect(selector.trim()).toMatch(/^\.agent-app /);
  });
});

describe("one primary action on the reviewer's dashboard", () => {
  const item = (count: number, href: string) => ({ count, href });

  it("makes the first live row primary and a repeat of the same destination a text link", () => {
    expect(actionStyles([item(13, "/admin/review"), item(6, "/admin/review"), item(3, "/admin/payouts"), item(0, "/admin/jobs")]))
      .toEqual(["primary", "link", "button", "button"]);
  });

  it("gives the primary to the first live row when the first is empty", () => {
    expect(actionStyles([item(0, "/admin/review"), item(2, "/admin/jobs")])).toEqual(["button", "primary"]);
  });

  it("drops the header button that repeated the queue link, and keeps the full tab labels", () => {
    const page = read("src/app/admin/page.tsx");
    expect(page).not.toContain('className="btn">Open the review queue');
    expect(page).toContain('<span className="tab-short">{tab.short}</span>');
  });
});

describe("an empty list shows its empty state alone", () => {
  it("does not draw the audit log's table when there are no events", () => {
    expect(read("src/app/admin/audit/page.tsx")).toContain("{events.length === 0 ? (");
  });
});
