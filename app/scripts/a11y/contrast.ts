/**
 * Colour contrast as WCAG 2.1 defines it, shared by the accessibility audit
 * and the design token test. Colours are sRGB with an alpha from 0 to 1.
 */
export type Rgba = { r: number; g: number; b: number; a: number };

/** SC 1.4.3: normal text. Large text (24 px, or 18.66 px bold) may use 3. */
export const TEXT_MINIMUM = 4.5;
/** SC 1.4.11: the boundary or state of a control, and a focus indicator. */
export const NON_TEXT_MINIMUM = 3;

/** Parses #rgb, #rrggbb, rgb() and rgba(), the forms the stylesheet and the browser produce. */
export function parseColor(text: string): Rgba {
  const value = text.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    const channel = (at: number) => Number.parseInt(full.slice(at, at + 2), 16);
    return { r: channel(0), g: channel(2), b: channel(4), a: 1 };
  }
  const parts = /^rgba?\(([^)]*)\)$/.exec(value)?.[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts && parts.length >= 3 && parts.every(Number.isFinite)) {
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }
  throw new Error(`Unrecognised colour: ${text}`);
}

/** `top` painted over an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const mix = (above: number, below: number) => above * top.a + below * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function luminance(color: Rgba): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** The contrast ratio, from 1 to 21, of an opaque or translucent foreground on an opaque background. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const a = luminance(composite(foreground, background));
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The colour seen through a stack of backgrounds, nearest first, over the white canvas. */
export function effectiveBackground(stack: string[]): Rgba {
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  return [...stack].reverse().reduce((below, layer) => composite(parseColor(layer), below), white);
}
