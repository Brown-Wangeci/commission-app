/**
 * Judges the texts axe reports as "incomplete" for colour contrast, from their
 * computed colours: the text colour against the backgrounds of its ancestors
 * (for text in a drawing, against the shape behind it). axe gives up on these
 * mostly because the element is scrolled out of view or under a sticky panel,
 * which does not change which colours it is drawn in.
 */
import type { Page } from "@playwright/test";
import { TEXT_MINIMUM, composite, contrastRatio, effectiveBackground, parseColor, type Rgba } from "./contrast";

/** SC 1.4.3: large text is 24 px, or 18.66 px and bold, and needs 3. */
const LARGE_TEXT_MINIMUM = 3;

type Sample =
  | { target: string; kind: "missing" }
  | { target: string; kind: "no-text" }
  | { target: string; kind: "text"; color: string; backgrounds: string[]; overImage: boolean; opacity: number; fontPx: number; weight: number };

export type Resolved = { target: string; verdict: "pass" | "fail" | "undetermined" | "no text"; ratio?: number; required?: number; color?: string };

async function sample(page: Page, targets: string[]): Promise<Sample[]> {
  // tsx compiles named functions with an __name() helper that the browser lacks.
  await page.evaluate("window.__name = (f) => f");
  return page.evaluate((selectors) => {
    const stackFrom = (start: Element | null) => {
      const stack: string[] = [];
      for (let el = start; el; el = el.parentElement) {
        const color = getComputedStyle(el).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)") stack.push(color);
        if (color.startsWith("rgb(")) break;
      }
      return stack;
    };
    const opacityOf = (start: Element) => {
      let value = 1;
      for (let el: Element | null = start; el; el = el.parentElement) value *= Number(getComputedStyle(el).opacity);
      return value;
    };
    /** The fill of the last shape drawn before this text that covers its centre. */
    const shapeBehind = (text: Element) => {
      const box = text.getBoundingClientRect();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const covering = [...text.closest("svg")!.querySelectorAll("circle, rect")].filter((shape) => {
        const b = shape.getBoundingClientRect();
        const before = Boolean(shape.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING);
        return before && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
      });
      const top = covering.at(-1);
      return top ? getComputedStyle(top).fill : null;
    };
    return selectors.map((target): Sample => {
      const el = document.querySelector(target);
      if (!el) return { target, kind: "missing" };
      const inDrawing = el instanceof SVGElement && el.closest("svg") !== null;
      const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (field && el.value === "") return { target, kind: "no-text" };
      const style = getComputedStyle(el);
      const behind = inDrawing ? shapeBehind(el) : null;
      const backgrounds = [...(behind ? [behind] : []), ...stackFrom(inDrawing ? el.closest("svg") : el)];
      const holder = el.parentElement;
      return {
        target, kind: "text", color: inDrawing ? style.fill : style.color, backgrounds,
        overImage: Boolean(holder?.querySelector("img")) && !style.backgroundColor.startsWith("rgb("),
        opacity: opacityOf(el), fontPx: parseFloat(style.fontSize), weight: Number(style.fontWeight),
      };
    });
  }, targets);
}

/** The worst case behind a translucent label on a photo: the photo may be black or white. */
function backdrops(backgrounds: string[], overImage: boolean): Rgba[] {
  if (!overImage || backgrounds.length === 0) return [effectiveBackground(backgrounds)];
  const label = parseColor(backgrounds[0]);
  return ["#000000", "#ffffff"].map((photo) => composite(label, parseColor(photo)));
}

function judge(item: Sample): Resolved {
  if (item.kind === "missing") return { target: item.target, verdict: "undetermined" };
  if (item.kind === "no-text") return { target: item.target, verdict: "no text" };
  try {
    const color = parseColor(item.color);
    const text = { ...color, a: color.a * item.opacity };
    const ratio = Math.min(...backdrops(item.backgrounds, item.overImage).map((behind) => contrastRatio(text, behind)));
    const large = item.fontPx >= 24 || (item.fontPx >= 18.66 && item.weight >= 700);
    const required = large ? LARGE_TEXT_MINIMUM : TEXT_MINIMUM;
    return { target: item.target, verdict: ratio >= required ? "pass" : "fail", ratio: Math.floor(ratio * 100) / 100, required, color: item.color };
  } catch {
    return { target: item.target, verdict: "undetermined", color: item.color };
  }
}

export async function resolveUnjudged(page: Page, targets: string[]): Promise<Resolved[]> {
  if (targets.length === 0) return [];
  return (await sample(page, targets)).map(judge);
}
