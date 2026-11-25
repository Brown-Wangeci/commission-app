/**
 * IR-10: the contrast of the design tokens. The audit script measures screens
 * as they render; this holds every colour pair the stylesheet can produce,
 * including hover, error and focus states a page scan never shows, so a token
 * change that breaks WCAG 2.1 AA fails before it is merged.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NON_TEXT_MINIMUM, TEXT_MINIMUM, contrastRatio, effectiveBackground, parseColor } from "../scripts/a11y/contrast";

const appDir = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(appDir, "src/app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const declared = new Map(
  [...(/:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
);

/** A token's colour, following aliases such as --raise: var(--status-pending). */
function token(name: string): string {
  const value = declared.get(name);
  if (!value) throw new Error(`No token ${name} in globals.css`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  return alias ? token(alias) : value;
}

const ratio = (foreground: string, background: string) =>
  contrastRatio(parseColor(token(foreground)), effectiveBackground([token(background)]));

const NEUTRAL = ["--surface", "--bg"];
const TINTS = ["--accent-soft", "--status-pending-soft", "--status-disputed-soft", "--status-clawback-soft"];

/** Each token used as a text colour, and the backgrounds it is drawn on. */
const TEXT: Record<string, string[]> = {
  "--ink": [...NEUTRAL, ...TINTS, "--line"],
  "--ink-2": [...NEUTRAL, ...TINTS, "--line"],
  "--ink-3": [...NEUTRAL, ...TINTS, "--line"],
  "--ink-4": [...NEUTRAL, ...TINTS],
  "--muted": [...NEUTRAL, ...TINTS, "--line"],
  "--lower": [...NEUTRAL, ...TINTS],
  "--accent": [...NEUTRAL, "--accent-soft"],
  "--accent-ink": [...NEUTRAL, "--accent-soft"],
  "--status-accrued": NEUTRAL,
  "--status-paid": [...NEUTRAL, "--accent-soft"],
  "--status-pending": [...NEUTRAL, "--status-pending-soft"],
  "--status-disputed": [...NEUTRAL, "--status-disputed-soft"],
  "--raise": [...NEUTRAL, "--raise-soft"],
  "--warn": [...NEUTRAL, "--warn-soft"],
  "--flag": [...NEUTRAL, "--flag-soft"],
  "--danger": [...NEUTRAL, "--danger-soft"],
  "--agent": [...NEUTRAL, "--agent-soft"],
  "--on-accent": ["--accent", "--accent-ink", "--raise"],
};

/** Boundaries, rings and marks a reader needs to see (SC 1.4.11). */
const NON_TEXT: Record<string, string[]> = {
  "--line-control": [...NEUTRAL, ...TINTS],
  "--accent": [...NEUTRAL, ...TINTS],
  "--ink-3": NEUTRAL,
  "--status-pending": NEUTRAL,
  "--status-disputed": NEUTRAL,
  "--flag": NEUTRAL,
};

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
const textColours = rules.flatMap((rule) =>
  [...rule.body.matchAll(/(?:^|;)\s*color\s*:\s*([^;]+)/g)].map((m) => ({ selector: rule.selector, value: m[1].trim() })),
);

const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe("design token contrast (IR-10)", () => {
  it("gives every text token at least 4.5:1 on each background it is used on", () => {
    const failures = Object.entries(TEXT).flatMap(([fg, backgrounds]) =>
      backgrounds.filter((bg) => ratio(fg, bg) < TEXT_MINIMUM).map((bg) => `${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`),
    );
    expect(failures).toEqual([]);
  });

  it("gives field boundaries, focus rings and status marks at least 3:1", () => {
    const failures = Object.entries(NON_TEXT).flatMap(([fg, backgrounds]) =>
      backgrounds.filter((bg) => ratio(fg, bg) < NON_TEXT_MINIMUM).map((bg) => `${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`),
    );
    expect(failures).toEqual([]);
  });

  it("keeps white text on a photo label readable whatever the photo", () => {
    for (const photo of ["#000000", "#ffffff"]) {
      const label = effectiveBackground([token("--overlay"), photo]);
      expect(contrastRatio(parseColor(token("--on-accent")), label)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
    }
  });

  it("colours text only with a checked token, except on disabled controls (exempt under SC 1.4.3)", () => {
    expect(textColours.length).toBeGreaterThan(40);
    const unchecked = textColours.filter(({ selector, value }) => {
      if (selector.includes(":disabled") || value === "inherit") return false;
      const name = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
      return !name || !(name in TEXT);
    });
    expect(unchecked).toEqual([]);
  });

  it("draws fields with the boundary token, on hover too", () => {
    const body = (selector: string) => rules.find((rule) => rule.selector === selector)?.body ?? "";
    expect(body(".input, .select, .textarea")).toContain("border: 1px solid var(--line-control)");
    expect(body(".input:hover, .select:hover, .textarea:hover")).toContain("border-color: var(--ink-3)");
    expect(body(".input::placeholder, .textarea::placeholder")).toContain("color: var(--ink-4)");
  });

  it("leaves no colour of their own in components", () => {
    const offences = sources(path.join(appDir, "src")).flatMap((file) => {
      const text = fs.readFileSync(file, "utf8");
      const literal = [...text.matchAll(/(?:color|background|fill|stroke|border)\w*\s*[:=]\s*["'`](#[0-9a-fA-F]{3,8}|rgba?\([^"'`]*)/g)].map((m) => m[1]);
      const colours = [...text.matchAll(/\bcolor:\s*[^,}\n]*?var\((--[\w-]+)\)/g)].map((m) => m[1]).filter((name) => !(name in TEXT));
      return [...literal, ...colours].map((found) => `${path.relative(appDir, file)}: ${found}`);
    });
    expect(offences).toEqual([]);
  });
});
