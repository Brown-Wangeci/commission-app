import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChoiceGroup, choiceLayout } from "@/components/ChoiceGroup";
import { PhoneInput } from "@/components/PhoneInput";
import { StickyActionBar } from "@/components/StickyActionBar";
import { EvidenceFieldInputs, type AttachedPhoto } from "@/components/agent/EvidenceFieldInputs";
import { ReviewChoice } from "@/components/client/PostJobForm";
import { validateEvidence, type FieldDefinition } from "@/lib/evidence/fields";
import { PLATFORM_FIELDS } from "@/lib/evidence/platform";
import { parseKshToCents } from "@/lib/money/cents";
import { groupKsh, groupPhone } from "@/lib/ui/format";
import { kenyanMsisdnSchema } from "@/lib/validation";

/**
 * UI pass, PR 2: native-feeling inputs and photo tiles. Each formatter keeps
 * to a form the server already accepts, so nothing validated or stored
 * changes; these tests hold that, and the markup the new controls render.
 */
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");

describe("phone numbers are grouped as typed, and the server reads them unchanged", () => {
  it("groups local and international forms", () => {
    expect(groupPhone("0712345678")).toBe("0712 345 678");
    expect(groupPhone("0112345678")).toBe("0112 345 678");
    expect(groupPhone("+254712345678")).toBe("+254 712 345 678");
    expect(groupPhone("254712345678")).toBe("254 712 345 678");
  });

  it("groups a partly typed number, keeps a lone plus, and stops at a full number", () => {
    expect(groupPhone("07123")).toBe("0712 3");
    expect(groupPhone("+")).toBe("+");
    expect(groupPhone("")).toBe("");
    expect(groupPhone("0712 345 678 99")).toBe("0712 345 678");
    expect(groupPhone("0712-345-678")).toBe("0712 345 678");
  });

  it("stores the same number whether it was typed grouped or not", () => {
    for (const raw of ["0712345678", "+254712345678", "254112345678"]) {
      expect(kenyanMsisdnSchema.parse(groupPhone(raw))).toBe(kenyanMsisdnSchema.parse(raw));
    }
    const phone = PLATFORM_FIELDS.filter((field) => field.type === "phone");
    const values = (msisdn: string) => ({ values: { [phone[0].key]: msisdn }, photoCounts: {} });
    const grouped = validateEvidence(phone, values(groupPhone("0712345678")), { today: "2026-11-25" });
    const plain = validateEvidence(phone, values("0712345678"), { today: "2026-11-25" });
    expect(grouped).toEqual(plain);
  });

  it("renders a phone input for the keypad, without offering the agent's own number for a customer's", () => {
    const html = renderToStaticMarkup(<PhoneInput id="p" name="field:x" autoComplete="off" defaultValue="0712345678" />);
    expect(html).toContain('inputMode="tel"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('value="0712 345 678"');
    expect(html).toContain('name="field:x"');
  });
});

describe("shilling amounts regroup when the field is left, and parse to the same cents", () => {
  it("adds thousands separators and two decimals where there were any", () => {
    expect(groupKsh("5000")).toBe("5,000");
    expect(groupKsh("2500.5")).toBe("2,500.50");
    expect(groupKsh("1234567.89")).toBe("1,234,567.89");
    expect(groupKsh("KSh 300")).toBe("300");
  });

  it("leaves what the parser refuses exactly as typed", () => {
    for (const raw of ["", "abc", "12.345", "-5"]) expect(groupKsh(raw)).toBe(raw);
  });

  it("never changes the amount", () => {
    for (const raw of ["5000", "2500.5", "1234567.89", "0.01", "10"]) expect(parseKshToCents(groupKsh(raw))).toBe(parseKshToCents(raw));
  });

  it("is applied to the post-a-job shilling fields and the escrow amount, with the unit in the box", () => {
    const post = read("src/components/client/PostJobForm.tsx");
    expect(post).toContain('const SHILLINGS: ReadonlyArray<keyof Terms> = ["value", "flat"];');
    expect(post).toContain("groupKsh(e.target.value)");
    const fund = read("src/components/client/FundForm.tsx");
    expect(fund).toContain("e.target.value = groupKsh(e.target.value);");
    expect(fund).toContain('<PhoneInput id="payerMsisdn" name="payerMsisdn"');
  });
});

describe("short choices are segments, longer ones are cards, and both are native radios", () => {
  const two = [{ value: "qr", label: "Scanned" }, { value: "typed", label: "Typed" }];

  it("chooses the layout from the number and length of the options", () => {
    expect(choiceLayout(two)).toBe("segmented");
    expect(choiceLayout([{ value: "a", label: "Scanned the code on the SIM pack" }, { value: "b", label: "Typed" }])).toBe("cards");
    expect(choiceLayout(["A", "B", "C", "D"].map((v) => ({ value: v, label: v })))).toBe("cards");
  });

  it("renders a labelled radio group with the same names and values", () => {
    const html = renderToStaticMarkup(<ChoiceGroup name="method" options={two} labelledBy="m-label" defaultValue="typed" />);
    expect(html).toContain('role="radiogroup" aria-labelledby="m-label" class="choice-group segmented"');
    expect(html).toContain('type="radio" name="method" value="qr"');
    expect(html).toContain('<input type="radio" name="method" checked="" value="typed"/>');
  });

  it("draws the platform's capture method as cards, and keeps a long option list as a select", () => {
    const html = renderToStaticMarkup(<EvidenceFieldInputs fields={PLATFORM_FIELDS} errors={{}} photos={{}} locationKnown today="2026-11-25" />);
    expect(html).toContain('class="choice-group cards"');
    const five: FieldDefinition = { key: "field_1", label: "Bundle", type: "single_select", mandatory: true, help: null, format: { options: ["A", "B", "C", "D", "E"].map((v) => ({ value: v, label: v })) } };
    expect(renderToStaticMarkup(<EvidenceFieldInputs fields={[five]} errors={{}} photos={{}} locationKnown today="2026-11-25" />)).toContain("<select");
  });

  it("offers the job's review choice as cards that default to the account setting", () => {
    const html = renderToStaticMarkup(<ReviewChoice accountSetting={false} />);
    expect(html).toContain('<input type="radio" name="reviewChoice" checked="" value=""/>');
    expect(html).toContain("Use my account setting (currently off)");
    expect(html).toContain('class="choice-group cards"');
  });

  it("uses a segmented role choice and a grouped payout number on sign-up", () => {
    const signup = read("src/app/signup/SignupForm.tsx");
    expect(signup).toContain('<ChoiceGroup name="role" options={ROLE_CHOICES}');
    expect(signup).toContain('<PhoneInput id="payoutMsisdn" name="payoutMsisdn"');
    expect(choiceLayout([{ value: "agent", label: "An agent" }, { value: "client", label: "A client business" }])).toBe("segmented");
  });
});

describe("photos are tiles with thumbnails, a remove button and progress", () => {
  const field: FieldDefinition = { key: "field_1", label: "Stall", type: "photo", mandatory: true, help: null, format: { minCount: 1, maxCount: 3 } };
  const render = (photos: AttachedPhoto[], locationKnown = true) =>
    renderToStaticMarkup(<EvidenceFieldInputs fields={[field]} errors={{}} photos={{ field_1: photos }} locationKnown={locationKnown} today="2026-11-25" />);

  it("shows each photo's thumbnail, a labelled remove button, and a flag when it has no location", () => {
    const html = render([{ name: "a.jpg", located: true, previewUrl: "blob:a" }, { name: "b.jpg", located: false, previewUrl: "blob:b" }]);
    expect(html).toContain('<img src="blob:a" alt="Photo 1"/>');
    expect(html).toContain('aria-label="Remove photo 2"');
    expect(html.match(/No location/g)).toHaveLength(1);
    expect(html).toContain("2 of 3 attached.");
    expect(html).toContain("Add another");
  });

  it("offers a take-photo tile while there is room, and hides it, disabled, when full", () => {
    expect(render([])).toContain("Take photo");
    expect(render([])).toMatch(/<div class="photo-add"><input id="f-field_1" type="file"/);
    const full = render([1, 2, 3].map((n) => ({ name: `${n}.jpg`, located: true })));
    expect(full).toContain('class="photo-add visually-hidden"');
    expect(full).toMatch(/type="file"[^>]*disabled=""/);
  });

  it("says when photos will carry no location", () => {
    expect(render([], false)).toContain("your location is not available");
  });

  it("gives the remove button and the add tile the 48 px agent target", () => {
    const css = read("src/app/globals.css");
    expect(css).toContain(".photo-remove { position: absolute; top: 0; right: 0; width: var(--touch); height: var(--touch);");
    expect(css).toMatch(/\.photo-tiles \{[^}]*minmax\(96px, 1fr\)/);
  });
});

describe("hints say only what the control does not", () => {
  const html = renderToStaticMarkup(<EvidenceFieldInputs fields={PLATFORM_FIELDS} errors={{}} photos={{}} locationKnown today="2026-11-25" />);

  it("keeps the no-future limit on the SIM date picker and says it plainly", () => {
    expect(html).toContain('type="date" class="input" max="2026-11-25"');
    expect(html).toContain("Not in the future");
    expect(html).not.toContain("Date (YYYY-MM-DD)");
  });

  it("drops the list of options under a choice the agent can already see", () => {
    expect(html).not.toContain("One of:");
  });
});

describe("the main action stays in reach on a phone", () => {
  it("renders the action bar with its note", () => {
    const html = renderToStaticMarkup(<StickyActionBar note="Getting your photos ready to send."><button>Go</button></StickyActionBar>);
    expect(html).toBe('<div class="action-bar"><div class="action-bar-note">Getting your photos ready to send.</div><button>Go</button></div>');
  });

  it("sticks to the bottom at 640 px and below, and holds the activation submit and the activity save", () => {
    expect(read("src/app/globals.css")).toMatch(/@media \(max-width: 640px\) \{\s*\.action-bar \{\s*position: sticky; bottom: 0;/);
    expect(read("src/components/agent/SubmitActivationForm.tsx")).toContain("<StickyActionBar");
    expect(read("src/components/client/ActivityForm.tsx")).toContain("<StickyActionBar>");
  });
});
