/**
 * How each "Needs your attention" row offers its action, so the dashboard has
 * one primary button and does not repeat the same destination as a second
 * button: the first live row is primary, a later row whose link an earlier
 * live row already offers is a plain text link, and any other live row is a
 * secondary button.
 */
export type ActionStyle = "primary" | "button" | "link";

export function actionStyles(items: ReadonlyArray<{ count: number; href: string }>): ActionStyle[] {
  const offered = new Set<string>();
  let primaryGiven = false;
  return items.map((item) => {
    if (item.count === 0) return "button";
    if (offered.has(item.href)) return "link";
    offered.add(item.href);
    if (!primaryGiven) {
      primaryGiven = true;
      return "primary";
    }
    return "button";
  });
}
